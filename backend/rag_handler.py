import os
import json
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import FAISS
from langchain_google_genai import GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage # Import HumanMessage too

# Constants for LLM
MODEL_NAME = "gemini-2.0-flash-thinking-exp-01-21" # Using a stable model name

class DocumentRAG:
    """Handles loading, indexing (via FAISS), and querying of documents using Google AI."""

    def __init__(self, google_api_key: str):
        if not google_api_key:
            raise ValueError("Google API Key is required.")
        
        self.api_key = google_api_key
        self.vector_stores = {} # Store loaded vector stores in memory {file_path: vector_store}
        self.documents_cache = {} # Optional: Cache loaded documents {file_path: docs}

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

    def query(self, file_path: str, query_text: str, k: int = 4):
        """Queries the indexed document associated with file_path."""
        if file_path not in self.vector_stores:
            print(f"Info: Document {file_path} not indexed. Attempting load...")
            # Attempt to load/index on the fly
            if not self.load_and_index(file_path):
                 return {"error": f"Document {file_path} not found or failed to index."}
            print(f"Load and index successful for {file_path}.")


        vector_store = self.vector_stores[file_path]
        
        try:
            print(f"Querying {file_path} with: '{query_text}'")
            retrieved_docs = vector_store.similarity_search(query_text, k=k)
            
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