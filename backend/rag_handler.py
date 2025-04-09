import os
import json
import time
import re
import faiss
from langchain_google_genai import GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI
from langchain_community.vectorstores.faiss import FAISS
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.schema.document import Document
from langchain.prompts import ChatPromptTemplate
from langchain.schema.messages import SystemMessage, HumanMessage
from langchain.schema.output_parser import StrOutputParser
from typing import Dict, List, Any, Tuple, Optional
from langchain_community.embeddings import GooglePalmEmbeddings
from langchain_community.llms import GooglePalm
from langchain.schema.runnable import RunnablePassthrough
from langchain.prompts import PromptTemplate
from langchain.schema.retriever import BaseRetriever
from langchain.retrievers.self_query.base import SelfQueryRetriever

# Constants for LLM
MODEL_NAME = "gemini-2.0-flash-thinking-exp-01-21" # Using a stable model name

# Function to extract retry delay from error message
def extract_retry_delay(error_message):
    """Extract the retry delay in seconds from a rate limit error message."""
    try:
        # Look for patterns like "please retry after 20s" or "wait 30 seconds"
        seconds_pattern = re.compile(r'(?:retry after|wait|retry in) (\d+)(?:s| seconds)')
        minutes_pattern = re.compile(r'(?:retry after|wait|retry in) (\d+)(?:m| minutes)')
        
        # Check for seconds first
        seconds_match = seconds_pattern.search(str(error_message).lower())
        if seconds_match:
            return int(seconds_match.group(1))
        
        # Check for minutes
        minutes_match = minutes_pattern.search(str(error_message).lower())
        if minutes_match:
            return int(minutes_match.group(1)) * 60
        
        # Default delay if no pattern matches
        return 30
    except Exception:
        # If anything goes wrong with parsing, use a reasonable default
        return 30

class DocumentRAG:
    """Handles loading, indexing (via FAISS), and querying of documents using Google AI."""

    def __init__(self, google_api_key: str, model_name: str = "models/text-bison-001"):
        """
        Initialize the RAG handler with the specified LLM and embeddings model.
        """
        if not google_api_key:
            raise ValueError("Google API Key is required.")
        
        self.api_key = google_api_key
        self.vector_stores = {} # Store loaded vector stores in memory {file_path: vector_store}
        self.documents_cache = {} # Optional: Cache loaded documents {file_path: docs}
        self.model_name = model_name

        try:
            # Initialize LLM
            self.llm = ChatGoogleGenerativeAI(
                model=MODEL_NAME,
                google_api_key=self.api_key, 
                temperature=0.7,
            )
            # Initialize Embeddings
            self.embeddings = GoogleGenerativeAIEmbeddings(
                model="models/embedding-001", 
                google_api_key=self.api_key
            )
            print(f"Successfully initialized LLM ({MODEL_NAME}) and Embeddings.")
        except Exception as e:
            print(f"Error initializing Google AI models: {e}")
            raise

        # Will be initialized when needed
        self.vector_store = None 
        self.retriever = None
        self.rag_chain = None

    def _load_json_file(self, file_path: str):
        """Loads JSON data from a file."""
        try:
            with open(file_path, 'r', encoding='utf-8') as file:
                data = json.load(file)
                print(f"Successfully loaded JSON from {file_path}")
                return data
        except Exception as e:
            print(f"Error loading JSON file {file_path}: {e}")
            return None

    def _json_to_documents(self, json_data, source_metadata=None) -> list[Document]:
        """Converts JSON data (specifically Huridocs format) into LangChain Documents."""
        if not source_metadata:
            source_metadata = {}
        
        documents = []
        
        if isinstance(json_data, list):
            for i, item in enumerate(json_data):
                if isinstance(item, dict):
                    text = item.get('text', str(item))
                    item_metadata = source_metadata.copy()
                    item_metadata.update({
                        'huridocs_index': i,
                        'page_number': item.get('page_number', 'unknown'),
                        'type': item.get('type', 'unknown')
                    })
                    documents.append(Document(page_content=text, metadata=item_metadata))
        # Add handling for other JSON structures if necessary
        elif isinstance(json_data, dict):
             print("Warning: Handling top-level dictionary JSON as single document.")
             documents.append(Document(page_content=json.dumps(json_data, indent=2), metadata=source_metadata))

        print(f"Converted JSON to {len(documents)} documents.")
        return documents

    def _create_vector_store(self, documents: list[Document]):
        """Creates a FAISS vector store from LangChain Documents."""
        if not documents:
            print("No documents provided to create vector store.")
            return None
        try:
            text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)
            splits = text_splitter.split_documents(documents)
            
            if not splits:
                 print("Text splitting resulted in zero chunks.")
                 return None

            print(f"Split documents into {len(splits)} chunks.")
            
            vector_store = FAISS.from_documents(splits, self.embeddings)
            print(f"Created FAISS vector store.")
            return vector_store
        except Exception as e:
            print(f"Error creating vector store: {e}")
            return None

    def load_and_index(self, file_path: str) -> bool:
        """Loads a JSON file, converts it to documents, and creates/stores a vector store."""
        if file_path in self.vector_stores:
            print(f"Vector store for {file_path} already loaded.")
            return True
            
        print(f"Loading and indexing {file_path}...")
        json_data = self._load_json_file(file_path)
        if json_data is None:
            return False
        
        documents = self._json_to_documents(json_data, {"source_file": os.path.basename(file_path)})
        self.documents_cache[file_path] = documents # Cache the raw docs

        vector_store = self._create_vector_store(documents)
        if vector_store is None:
            return False
            
        self.vector_stores[file_path] = vector_store
        print(f"Successfully loaded and indexed {file_path}.")
        return True

    def generate_section_summaries(self, huridocs_json_file):
        """
        Generate summaries for each text segment/box in the Huridocs output.
        Returns a dictionary mapping segment IDs to their summaries.
        Saves intermediate results every 10 segments processed.
        """
        try:
            print(f"Generating summaries for text segments in {huridocs_json_file}")
            
            # Check for existing partial results to resume from
            summary_cache_file = huridocs_json_file.replace('.json', '_summaries.json')
            existing_summaries = {}
            
            if os.path.exists(summary_cache_file):
                try:
                    with open(summary_cache_file, 'r') as f:
                        existing_summaries = json.load(f)
                    print(f"Loaded {len(existing_summaries)} existing summaries to resume from")
                except Exception as e:
                    print(f"Error loading existing summaries, starting fresh: {e}")
            
            # Load the Huridocs JSON file
            with open(huridocs_json_file, 'r') as f:
                data = json.load(f)
            
            # Extract text segments from the JSON
            text_segments = {}
            summaries = existing_summaries.copy()  # Start with existing summaries
            
            # First, check the data structure to determine how to handle it
            if isinstance(data, list):
                # Handle case where data is a list of segments
                for i, segment in enumerate(data):
                    if isinstance(segment, dict) and 'text' in segment:
                        segment_id = segment.get('id', f'seg_{i}')
                        text_content = segment.get('text', '').strip()
                        
                        # Store page number and bbox if available
                        page_num = segment.get('page_number', 1)
                        bbox = segment.get('bbox', [])
                        
                        # Only process segments with meaningful content
                        if len(text_content) > 10:  # Skip very short segments
                            text_segments[segment_id] = {
                                'text': text_content,
                                'page': page_num,
                                'bbox': bbox
                            }
            elif isinstance(data, dict):
                # Handle case where data is a dict with 'pages' key
                if 'pages' in data and isinstance(data['pages'], list):
                    # Process standard Huridocs format with pages list
                    for page_idx, page in enumerate(data['pages']):
                        page_number = page_idx + 1
                        
                        # Check if page has 'texts' or 'items' key
                        if 'texts' in page and isinstance(page['texts'], list):
                            for text_block in page['texts']:
                                if isinstance(text_block, dict) and 'text' in text_block:
                                    segment_id = text_block.get('id', f'text_{page_number}_{id(text_block)}')
                                    text_content = text_block.get('text', '').strip()
                                    bbox = text_block.get('bbox', [])
                                    
                                    if len(text_content) > 10:
                                        text_segments[segment_id] = {
                                            'text': text_content,
                                            'page': page_number,
                                            'bbox': bbox
                                        }
                        
                        # Alternative format with 'items' instead of 'texts'
                        elif 'items' in page and isinstance(page['items'], list):
                            for item in page['items']:
                                if isinstance(item, dict) and item.get('type') == 'text':
                                    segment_id = item.get('id', f'item_{page_number}_{id(item)}')
                                    text_content = item.get('content', '').strip()
                                    bbox = item.get('bbox', [])
                                    
                                    if len(text_content) > 10:
                                        text_segments[segment_id] = {
                                            'text': text_content,
                                            'page': page_number,
                                            'bbox': bbox
                                        }
            
            # Filter out segments that already have summaries
            to_process = {k: v for k, v in text_segments.items() if k not in summaries}
            print(f"Found {len(text_segments)} total segments, {len(to_process)} remaining to process")
            
            # If no segments were found, attempt to create at least one from the whole document
            if not text_segments and isinstance(data, dict) and not summaries:
                document_text = json.dumps(data)[:1000]  # Take first 1000 chars as a sample
                text_segments['full_doc'] = {
                    'text': document_text,
                    'page': 1,
                    'bbox': []
                }
                to_process = text_segments.copy()
                print("No structured segments found, created one from whole document")
            
            # If there's nothing new to process, return existing summaries
            if not to_process:
                print("All segments already have summaries, nothing new to process")
                return summaries
            
            # Define a prompt template for summarization
            prompt_template = ChatPromptTemplate.from_messages([
                ("system", """You are an AI assistant that creates concise summaries of text segments from documents.
                Create a brief (1-3 sentence) summary that captures the key information in the text segment.
                Focus on extracting the main point, key facts, or central argument.
                If the text is too short or lacks substantial content, respond with "Insufficient content for summary."
                """),
                ("user", "Text segment: {text_content}\n\nSummary:")
            ])
            
            chain = prompt_template | self.llm | StrOutputParser()
            
            # Process each text segment
            segments_total = len(to_process)
            processed_count = 0
            batch_count = 0
            
            # Function to save intermediate results
            def save_intermediate_results():
                try:
                    with open(summary_cache_file, 'w') as f:
                        json.dump(summaries, f)
                    print(f"Saved intermediate results with {len(summaries)} summaries")
                except Exception as e:
                    print(f"Error saving intermediate results: {e}")
            
            for segment_id, segment_data in to_process.items():
                max_retries = 5
                retry_count = 0
                text_content = segment_data['text']
                
                while retry_count < max_retries:
                    try:
                        processed_count += 1
                        batch_count += 1
                        print(f"Generating summary [{processed_count}/{segments_total}] for segment {segment_id[:8] if len(segment_id) > 8 else segment_id}...")
                        
                        summary = chain.invoke({"text_content": text_content})
                        
                        # Store the segment data with its summary
                        summaries[segment_id] = {
                            'summary': summary.strip(),
                            'text': text_content,
                            'page': segment_data['page'],
                            'bbox': segment_data['bbox']
                        }
                        
                        # Save intermediate results every 10 segments
                        if batch_count >= 10:
                            save_intermediate_results()
                            batch_count = 0
                        
                        # Successfully processed this segment, break the retry loop
                        break
                        
                    except Exception as e:
                        error_msg = str(e)
                        print(f"Error generating summary for segment {segment_id}: {error_msg}")
                        
                        # Check if it's a rate limit error
                        if "rate limit" in error_msg.lower() or "quota" in error_msg.lower() or "limit exceeded" in error_msg.lower():
                            retry_count += 1
                            
                            if retry_count < max_retries:
                                # Extract retry delay from error message
                                delay = extract_retry_delay(error_msg)
                                print(f"Rate limit hit. Waiting for {delay} seconds before retry {retry_count}/{max_retries}...")
                                
                                # Save progress before waiting
                                save_intermediate_results()
                                
                                # Wait for the specified delay
                                time.sleep(delay)
                            else:
                                print(f"Maximum retries reached for segment {segment_id}. Skipping.")
                                # Store error in the summaries
                                summaries[segment_id] = {
                                    'summary': f"Rate limit error after {max_retries} retries.",
                                    'text': text_content,
                                    'page': segment_data['page'],
                                    'bbox': segment_data['bbox']
                                }
                                
                                # Save progress after abandoning segment
                                save_intermediate_results()
                                batch_count = 0
                        else:
                            # Not a rate limit error, store the error and move on
                            summaries[segment_id] = {
                                'summary': f"Error generating summary: {error_msg[:100]}...",
                                'text': text_content,
                                'page': segment_data['page'],
                                'bbox': segment_data['bbox']
                            }
                            break  # Exit retry loop for non-rate-limit errors
                
                # Add a small delay between segments to avoid hitting rate limits
                if processed_count < segments_total:
                    time.sleep(1)
            
            # Save final results
            save_intermediate_results()
            
            print(f"Successfully generated {len(summaries)} summaries in total")
            return summaries
            
        except Exception as e:
            print(f"Error during summary generation: {e}")
            return {}

    def load_and_index_with_summaries(self, huridocs_json_file):
        """
        Loads and indexes the document, and generates summaries for text segments.
        Returns a tuple: (success_flag, summaries or error message)
        """
        try:
            # First load and index the document normally
            success = self.load_and_index(huridocs_json_file)
            if not success:
                return False, "Failed to load and index document"
            
            # Then generate summaries
            summaries = self.generate_section_summaries(huridocs_json_file)
            
            return True, summaries
        except Exception as e:
            print(f"Error in load_and_index_with_summaries: {e}")
            return False, f"Error during document processing: {e}"

    def query(self, huridocs_json_file, query_text):
        """
        Query the indexed document with a specific question.
        """
        if huridocs_json_file not in self.vector_stores:
            print(f"Info: Document {huridocs_json_file} not indexed. Attempting load...")
            # Attempt to load/index on the fly
            if not self.load_and_index(huridocs_json_file):
                 return {"error": f"Document {huridocs_json_file} not found or failed to index."}
            print(f"Load and index successful for {huridocs_json_file}.")


        vector_store = self.vector_stores[huridocs_json_file]
        
        try:
            print(f"Querying {huridocs_json_file} with: '{query_text}'")
            retrieved_docs = vector_store.similarity_search(query_text, k=4)
            
            if not retrieved_docs:
                 print("No relevant documents found.")
                 return {"response": "I couldn't find any relevant information in the document to answer that.", "sources": []}

            # Build context string
            context = "\n\n---\n\n".join([doc.page_content for doc in retrieved_docs])
            
            # Define the prompt content using f-string outside HumanMessage for clarity
            human_prompt_content = f"""
Context from the document:
--------------------------
{context}
--------------------------

Question: {query_text}

Answer based strictly on the context above:"""

            # Create the prompt template
            prompt_template = ChatPromptTemplate.from_messages([
                SystemMessage(content="You are a helpful assistant answering questions based ONLY on the provided context from a document. If the context does not contain the answer, state that clearly. Do not make up information."),
                HumanMessage(content=human_prompt_content)
            ])
            
            chain = prompt_template | self.llm | StrOutputParser()
            
            # Invoke the chain - Input is implicitly handled by the template structure now
            response = chain.invoke({}) 
            
            print(f"LLM Response generated.")

            # Format sources
            sources = [
                 {
                      "content_preview": doc.page_content[:150] + "...",
                      "metadata": doc.metadata
                 } for doc in retrieved_docs
            ]

            return {"response": response, "sources": sources}

        except Exception as e:
            print(f"Error during query execution: {e}")
            return {"error": f"An error occurred while processing the query: {e}"} 