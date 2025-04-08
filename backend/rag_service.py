import os
import logging
from typing import List, Dict, Any

from llama_index.core import (
    VectorStoreIndex,
    SimpleDirectoryReader,
    Document,
    StorageContext,
    load_index_from_storage,
    Settings
)
from llama_index.core.node_parser import SimpleNodeParser
from llama_index.llms.gemini import Gemini
from llama_index.embeddings.gemini import GeminiEmbedding
# Add imports for direct LLM chat
from llama_index.core.llms import ChatMessage, MessageRole

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Define constants
STORAGE_DIR = "./rag_storage"
# Revert back to the user's preferred model
GEMINI_MODEL = "models/gemini-2.0-flash-thinking-exp-01-21"
# Ensure GOOGLE_API_KEY is set in your environment variables

class RAGService:
    def __init__(self, storage_dir: str = STORAGE_DIR, llm_model: str = GEMINI_MODEL):
        """Initializes the RAG Service."""
        self.storage_dir = storage_dir
        self.llm_model = llm_model
        self.index = None
        self.query_engine = None

        # Ensure storage directory exists
        os.makedirs(self.storage_dir, exist_ok=True)

        # Configure LlamaIndex settings with Gemini
        try:
            Settings.llm = Gemini(model_name=self.llm_model)
            # Using the default embedding model for Gemini, adjust if needed
            Settings.embed_model = GeminiEmbedding(model_name="models/embedding-001") 
            logger.info(f"Configured Gemini LLM ({self.llm_model}) and Embeddings.")
        except Exception as e:
            logger.error(f"Failed to configure Gemini models. Ensure GOOGLE_API_KEY is set and valid: {e}")
            # Potentially raise an error or handle gracefully
            raise

        self._load_or_create_index()

    def _load_or_create_index(self):
        """Loads the index from storage if it exists, otherwise initializes an empty index."""
        if os.path.exists(os.path.join(self.storage_dir, "docstore.json")): # Check if index likely exists
            try:
                logger.info(f"Loading index from: {self.storage_dir}")
                storage_context = StorageContext.from_defaults(persist_dir=self.storage_dir)
                self.index = load_index_from_storage(storage_context)
                logger.info("Index loaded successfully.")
            except Exception as e:
                logger.error(f"Failed to load index from {self.storage_dir}: {e}. Creating a new one.")
                # If loading fails, create a new empty index structure
                self.index = VectorStoreIndex.from_documents([], storage_context=StorageContext.from_defaults())
                self.index.storage_context.persist(persist_dir=self.storage_dir) # Persist the empty structure
        else:
            logger.info("No existing index found. Creating a new index.")
            # Create a new empty index structure
            self.index = VectorStoreIndex.from_documents([], storage_context=StorageContext.from_defaults())
            self.index.storage_context.persist(persist_dir=self.storage_dir) # Persist the empty structure

        if self.index is not None:
            self.query_engine = self.index.as_query_engine()
            logger.info("Query engine created.")
        else:
             logger.error("Index could not be loaded or created.")


    def process_huridocs_output(self, huridocs_data: List[Dict[str, Any]], document_id: str):
        """
        Processes the text content from Huridocs output, creates LlamaIndex Documents with metadata,
        and updates the index.

        Args:
            huridocs_data: A list of dictionaries representing Huridocs layout items.
                           Expected keys: 'text', 'page_number', potentially others like 'bbox'.
            document_id: A unique identifier for the source document (e.g., filename).
        """
        if not self.index:
            logger.error("Index is not initialized. Cannot process documents.")
            return {"error": "Index not initialized."}
        
        logger.info(f"Processing Huridocs output for document: {document_id}")

        nodes = []
        parser = SimpleNodeParser.from_defaults()

        # Group text by page for potential page-level processing later
        page_texts: Dict[int, str] = {}
        for item in huridocs_data:
            if 'text' in item and 'page_number' in item:
                page_num = item['page_number']
                if page_num not in page_texts:
                    page_texts[page_num] = ""
                page_texts[page_num] += item['text'] + "\n" # Add newline between text blocks

        # Log the page texts
        logger.info(f"Grouped text by page: {page_texts}")

        # Create Documents per page and generate nodes
        for page_num, text in page_texts.items():
            # Create a LlamaIndex Document for each page
            llama_document = Document(
                text=text,
                metadata={
                    "document_id": document_id,
                    "page_number": page_num,
                    # Add other relevant metadata if needed, e.g., filename
                }
            )
            # Log the document
            logger.info(f"Created LlamaIndex Document for page {page_num}: {llama_document}")
            # Generate nodes from this document
            page_nodes = parser.get_nodes_from_documents([llama_document])
            logger.info(f"Generated {len(page_nodes)} nodes for page {page_num}: {page_nodes}")
            nodes.extend(page_nodes)

        if not nodes:
            logger.warning(f"No text nodes extracted from Huridocs output for {document_id}.")
            return {"message": "No text content found to index."}

        logger.info(f"Generated {len(nodes)} nodes for document: {document_id}")

        # Update the index with the new nodes
        # Note: Using insert_nodes is generally better for updating existing indices
        # If the index can contain multiple documents.
        self.index.insert_nodes(nodes)
        logger.info(f"Inserted {len(nodes)} nodes into the index.")

        # Persist the updated index
        logger.info(f"Persisting updated index to: {self.storage_dir}")
        self.index.storage_context.persist(persist_dir=self.storage_dir)
        logger.info("Index updated and persisted successfully.")

        # Recreate query engine to reflect changes (important!)
        self.query_engine = self.index.as_query_engine()
        logger.info("Query engine updated.")

        return {"message": f"Document '{document_id}' processed and indexed successfully."}

    def query(self, query_text: str) -> Dict[str, Any]:
        """
        Queries the RAG index with the given text.
        """
        if not self.query_engine:
            logger.error("Query engine not initialized.")
            return {"error": "RAG query engine not initialized."}

        # List of descriptive queries that should trigger a document overview response
        descriptive_queries = [
            "what am i looking at", 
            "what is this document", 
            "what does this document contain",
            "describe this document",
            "summarize this document",
            "what is in this document",
            "what can you tell me about this document"
        ]
        
        # Normalize the query for checking against descriptive_queries
        normalized_query = query_text.lower().strip().rstrip("?")
        
        # Check if this is a descriptive query
        is_descriptive_query = any(q in normalized_query for q in descriptive_queries)
        
        try:
            logger.info(f"Querying RAG index with: '{query_text}'")
            
            # For descriptive queries, try to get a sample of document nodes for description
            if is_descriptive_query:
                logger.info(f"Detected descriptive query. Retrieving document overview.")
                # Get a sample of nodes from the index to generate a document overview
                if self.index and self.index.docstore:
                    # Get a sample of nodes from the document store
                    sample_nodes = list(self.index.docstore.docs.values())[:5]  # Limit to first 5 for brevity
                    
                    if sample_nodes:
                        # Create a prompt that asks the LLM to describe the document based on samples
                        sample_texts = [node.text[:200] + "..." for node in sample_nodes if hasattr(node, 'text')]
                        samples_str = "\n\n".join(sample_texts)
                        
                        descriptive_prompt = f"""The user is asking '{query_text}'. 
                        Based on the following samples from the document, please provide a brief description of what 
                        the document appears to contain or be about:
                        
                        {samples_str}
                        
                        Describe what type of document this appears to be and what content it contains."""
                        
                        # Use LLM directly for document description
                        return self.test_llm_direct(descriptive_prompt, is_fallback=False)
            
            # Standard RAG query for non-descriptive queries or if descriptive handling failed
            response = self.query_engine.query(query_text)
            
            # Log the raw response object
            logger.info(f"Raw response object from query engine: {response}")
            
            # Check if response is None or empty or literally "Empty Response"
            if (not response or 
                not hasattr(response, 'response') or 
                not response.response or 
                response.response == "Empty Response"):  # Added this condition
                
                logger.warning("Query engine returned an empty response or 'Empty Response'.")
                
                # Try document overview approach as fallback for non-descriptive queries too
                if self.index and self.index.docstore:
                    # Get a sample of nodes from the document store
                    sample_nodes = list(self.index.docstore.docs.values())[:5]
                    
                    if sample_nodes:
                        # Create a fallback prompt with document samples
                        sample_texts = [node.text[:200] + "..." for node in sample_nodes if hasattr(node, 'text')]
                        samples_str = "\n\n".join(sample_texts)
                        
                        fallback_prompt = f"""The user asked '{query_text}' about a document, but no specific 
                        information matching their query was found. Based on these samples from the document:
                        
                        {samples_str}
                        
                        Please provide a helpful response that explains what information is available in the document
                        and suggests how they might rephrase their query to get better results."""
                        
                        # Use LLM with document samples for better fallback
                        return self.test_llm_direct(fallback_prompt, is_fallback=True)
                
                # Default fallback if we couldn't get document samples
                fallback_response = "No relevant information was found in the indexed documents for your query. Please try a different query related to the content in the document."
                result = {
                    "response": fallback_response,
                    "source_nodes": []
                }
                logger.info(f"Returning fallback result: {result}")
                return result
            
            # Log the response content
            logger.info(f"Response content: '{response.response}'")
            
            # Extract source nodes
            source_nodes = []
            if hasattr(response, 'source_nodes') and response.source_nodes:
                for node in response.source_nodes:
                    # Log the node details
                    logger.info(f"Source node: {node}")
                    source_nodes.append({
                        "text": node.node.text,
                        "score": node.score if hasattr(node, 'score') else None
                    })
            
            # Log the source nodes
            logger.info(f"Found {len(source_nodes)} source nodes: {source_nodes}")
            
            result = {
                "response": response.response,
                "source_nodes": source_nodes
            }
            logger.info(f"Returning result from query: {result}")
            return result
        except Exception as e:
            logger.exception(f"Error during query processing: {e}") # Use logger.exception to include stack trace
            return {"error": f"Failed to process query: {e}"}

    def test_llm_direct(self, prompt: str, is_fallback: bool = False) -> Dict[str, Any]:
        """
        Sends a prompt directly to the configured LLM, bypassing RAG.
        
        Args:
            prompt: The prompt to send to the LLM.
            is_fallback: Whether this is being called as a fallback from the query method.
        """
        logger.info(f"Attempting direct LLM call with prompt: '{prompt}'")
        if not Settings.llm:
            logger.error("LLM not configured in Settings.")
            return {"error": "LLM not configured in LlamaIndex Settings."}
        
        try:
            # Log the LLM configuration
            logger.info(f"Using LLM: {Settings.llm.__class__.__name__}")
            
            # Use the chat interface for Gemini models
            messages = [ChatMessage(role=MessageRole.USER, content=prompt)]
            logger.info(f"Sending messages to LLM: {messages}")
            
            response = Settings.llm.chat(messages)
            
            # Log the raw response object from the LLM
            logger.info(f"Direct LLM call successful. Response object type: {type(response)}")
            logger.info(f"Raw response object: {response}")
            
            # Extract the response content
            response_content = response.message.content if response and hasattr(response, 'message') and hasattr(response.message, 'content') else None
            
            if response_content:
                logger.info(f"Successfully extracted content from direct LLM response: '{response_content}'" )
                logger.info(f"COMPLETE LLM RESPONSE: {response_content}")
                
                # If this is a fallback call, add a preamble
                if is_fallback:
                    final_response = "[No relevant context found in your documents. Here's a general response:]\n\n" + response_content
                else:
                    final_response = response_content
                
                # Return with the key 'response' to match the query method's response format
                result = {"response": final_response, "source_nodes": []}
                logger.info(f"Returning result from test_llm_direct: {result}")
                return result
            else:
                logger.warning("Direct LLM call returned a response object, but could not extract message content.")
                return {"error": "LLM responded, but content extraction failed.", "raw_response": str(response)}
                
        except Exception as e:
            logger.exception(f"Error during direct LLM call: {e}")
            return {"error": f"Failed to communicate with LLM directly: {e}"}

# Example usage (optional, for testing)
if __name__ == '__main__':
    # Ensure GOOGLE_API_KEY is set as an environment variable before running
    if not os.getenv("GOOGLE_API_KEY"):
       print("Error: GOOGLE_API_KEY environment variable not set.")
    else:
        print("Initializing RAG Service...")
        rag_service = RAGService()
        print("RAG Service Initialized.")

        # Example: Simulate processing Huridocs data
        # sample_huridocs = [
        #     {'text': 'This is the first page content.', 'page_number': 1},
        #     {'text': 'More text from page one.', 'page_number': 1},
        #     {'text': 'Content from the second page.', 'page_number': 2},
        # ]
        # print(rag_service.process_huridocs_output(sample_huridocs, "test_document.pdf"))

        # Example: Querying
        # query = "What is on the first page?"
        # result = rag_service.query(query)
        # print(f"Query: {query}")
        # print(f"Response: {result.get('response')}")
        # print(f"Source Nodes: {result.get('source_nodes')}") 