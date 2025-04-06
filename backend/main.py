from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import List, Dict, Any
import os
import json
from llama_index.core import VectorStoreIndex, SimpleDirectoryReader, Document, StorageContext, load_index_from_storage
from llama_index.core.node_parser import SimpleNodeParser
from llama_index.core.settings import Settings
from llama_index.llms.openai import OpenAI
import uvicorn

# Initialize FastAPI app
app = FastAPI(title="RAG API")

# Initialize OpenAI
llm = OpenAI(model="gpt-4o-mini")

# Configure LlamaIndex settings
Settings.llm = llm

STORAGE_DIR = "./llama_index_storage"
os.makedirs(STORAGE_DIR, exist_ok=True)

class Query(BaseModel):
    text: str

class Document(BaseModel):
    content: str
    metadata: dict = {}

class PDFContentObj(BaseModel):
    left: float
    top: float
    width: float
    height: float
    page_number: int
    page_width: int
    page_height: int
    text: str
    type: str

# (Storing)
def load_or_create_index():
    """Load index from disk if it exists, otherwise return None"""
    try:
        # Reconstruct storage context
        storage_context = StorageContext.from_defaults(persist_dir=STORAGE_DIR)
        # Load index from storage
        return load_index_from_storage(storage_context)
    except:
        return None

# Try to load existing index on startup
app.state.index = load_or_create_index()

@app.post("/process-pdf-content")
async def process_pdf_content(pdf_content_obj: List[PDFContentObj]):
    try:
        # Extract text values from the PDF content objects
        extracted_texts = [item.text for item in pdf_content_obj]
        
        # Create a single document with all extracted texts
        combined_text = "\n".join(extracted_texts)
        
        # Create LlamaIndex document (Loading)
        llama_document = Document(text=combined_text)
        
        # Create index (Indexing)
        parser = SimpleNodeParser.from_defaults()
        nodes = parser.get_nodes_from_documents([llama_document])
        index = VectorStoreIndex(nodes)
        
        # Store index in memory and persist to disk
        app.state.index = index
        index.storage_context.persist(persist_dir=STORAGE_DIR)
        
        return {"message": "PDF content processed and indexed successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# @app.post("/index")
# async def index_documents(documents: List[Document]):
#     try:
#         # Create a temporary directory to store documents
#         os.makedirs("temp_docs", exist_ok=True)
        
#         # Write documents to files
#         for i, doc in enumerate(documents):
#             with open(f"temp_docs/doc_{i}.txt", "w") as f:
#                 f.write(doc.content)
        
#         # Load documents
#         documents = SimpleDirectoryReader("temp_docs").load_data()
        
#         # Create index
#         parser = SimpleNodeParser.from_defaults()
#         nodes = parser.get_nodes_from_documents(documents)
#         index = VectorStoreIndex(nodes)
        
#         # Store index in memory and persist to disk
#         app.state.index = index
#         index.storage_context.persist(persist_dir=STORAGE_DIR)
        
#         return {"message": "Documents indexed successfully"}
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=str(e))

# (Querying)
@app.post("/query")
async def query_documents(query: Query):
    try:
        if not hasattr(app.state, "index"):
            raise HTTPException(status_code=400, detail="No documents have been indexed yet")
        
        # Create query engine
        query_engine = app.state.index.as_query_engine()
        
        # Get response
        response = query_engine.query(query.text)
        
        return {"response": str(response)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000) 