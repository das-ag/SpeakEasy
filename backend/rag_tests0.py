import os
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage, SystemMessage

MODEL_NAME = "gemini-2.0-flash-thinking-exp-01-21"
load_dotenv()
api_key = os.getenv("GOOGLE_API_KEY")
if not api_key:
    raise ValueError("GOOGLE_API_KEY not found in environment variables. "
                     "Please set it in your .env file or system environment.")

try:
    llm = ChatGoogleGenerativeAI(
        model=MODEL_NAME,
        google_api_key=api_key, # Can omit if GOOGLE_API_KEY env var is set
        temperature=0.7,       # Adjust creativity (0.0 - 1.0)
        # top_p=0.9,           # Optional: nucleus sampling
        # top_k=40,            # Optional: top-k sampling
        # max_output_tokens=1024 # Optional: Limit response length
    )
    print(f"Successfully initialized model: {MODEL_NAME}")

except Exception as e:
    print(f"Error initializing model '{MODEL_NAME}': {e}")
    print("This could be due to several reasons:")
    print("1. The experimental model name is incorrect or deprecated.")
    print("2. Your API key does not have access to this specific experimental model.")
    print("3. The model is temporarily unavailable or restricted by region.")
    print("Consider trying a stable model like 'gemini-1.5-flash-latest' or 'gemini-1.5-pro-latest'.")
    exit() # Exit if initialization fails

# --- Use the Model (Example Invocations) ---

# Example 1: Simple invocation with a string prompt
try:
    prompt = "Explain the concept of Chain-of-Thought prompting in 1-2 sentences."
    print(f"\n--- Invoking with simple prompt: ---\n{prompt}")
    response = llm.invoke(prompt)
    print("\n--- Response ---")
    print(response.content)

except Exception as e:
    print(f"\nError during invocation: {e}")


# Example 2: Invocation with message history (System + Human)
try:
    messages = [
        SystemMessage(content="You are a helpful assistant that provides concise explanations."),
        HumanMessage(content="What is the capital of France?"),
    ]
    print(f"\n--- Invoking with messages: ---")
    print(messages)
    response = llm.invoke(messages)
    print("\n--- Response ---")
    print(response.content)

except Exception as e:
    print(f"\nError during invocation with messages: {e}")


# --- Load and Query JSON Data with LangChain and Google LLM ---
import os
import json
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import FAISS
from langchain_google_genai import GoogleGenerativeAIEmbeddings

# Function to load JSON data from a file
def load_json_file(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            data = json.load(file)
            print(f"Successfully loaded JSON from {file_path}")
            return data
    except Exception as e:
        print(f"Error loading JSON file {file_path}: {e}")
        return None

# Function to convert JSON data to documents
def json_to_documents(json_data, metadata=None):
    if not metadata:
        metadata = {}
    
    documents = []
    
    # Handle different JSON structures
    if isinstance(json_data, list):
        # For array of objects like Huridocs output
        for i, item in enumerate(json_data):
            if isinstance(item, dict):
                # Extract text if available
                text = item.get('text', str(item))
                # Create metadata with item-specific info
                item_metadata = metadata.copy()
                item_metadata.update({
                    'index': i,
                    'page_number': item.get('page_number', 'unknown'),
                    'type': item.get('type', 'unknown')
                })
                documents.append(Document(page_content=text, metadata=item_metadata))
    elif isinstance(json_data, dict):
        # For single objects
        for key, value in json_data.items():
            if isinstance(value, str):
                item_metadata = metadata.copy()
                item_metadata['key'] = key
                documents.append(Document(page_content=value, metadata=item_metadata))
            elif isinstance(value, (dict, list)):
                # Recursively process nested structures
                nested_docs = json_to_documents(value, {**metadata, 'parent_key': key})
                documents.extend(nested_docs)
    
    return documents

# Function to create a vector store from documents
def create_vector_store(documents):
    # Split documents into chunks
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=100
    )
    splits = text_splitter.split_documents(documents)
    
    # Create embeddings using Google's embedding model
    embeddings = GoogleGenerativeAIEmbeddings(model="models/embedding-001")
    
    # Create vector store
    vector_store = FAISS.from_documents(splits, embeddings)
    print(f"Created vector store with {len(splits)} document chunks")
    
    return vector_store

# Function to query the vector store
def query_json_data(vector_store, query_text, k=3):
    # Retrieve relevant documents
    retrieved_docs = vector_store.similarity_search(query_text, k=k)
    
    # Create context from retrieved documents
    context = "\n\n".join([doc.page_content for doc in retrieved_docs])
    
    # Create prompt template
    prompt = ChatPromptTemplate.from_template("""
    You are an assistant that answers questions based on the provided context.
    
    Context:
    {context}
    
    Question: {question}
    
    Answer the question based only on the provided context. If the context doesn't contain 
    the information needed to answer the question, say "I don't have enough information to 
    answer this question based on the provided context."
    """)
    
    # Create chain
    chain = prompt | llm | StrOutputParser()
    
    # Execute chain
    response = chain.invoke({"context": context, "question": query_text})
    
    return {
        "response": response,
        "source_documents": retrieved_docs
    }

# Example usage
if os.path.exists("./huridocs_output"):
    # Load a sample JSON file
    sample_file = "./huridocs_output/bf6f80ae6c08aa62fd2de9f1d14f2606110fcc5ce0d5cd019c19a766bf3558f1.json"
    json_data = load_json_file(sample_file)
    
    if json_data:
        # Convert to documents
        documents = json_to_documents(json_data, {"source_file": sample_file})
        print(f"Created {len(documents)} documents from JSON data")
        
        # Create vector store
        vector_store = create_vector_store(documents)
        
        # Query example
        query = "What is the title of this document?"
        print(f"\n--- Querying: {query} ---")
        result = query_json_data(vector_store, query)
        
        print("\n--- Response ---")
        print(result["response"])
        
        print("\n--- Sources ---")
        for i, doc in enumerate(result["source_documents"]):
            print(f"Source {i+1}:")
            print(f"Content: {doc.page_content[:100]}...")
            print(f"Metadata: {doc.metadata}")
            print()
else:
    print("Huridocs output directory not found. Please adjust the path to your JSON files.")



