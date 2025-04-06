# PDF Content RAG Backend

A FastAPI-based backend service that implements a Retrieval-Augmented Generation (RAG) system using LlamaIndex. This service is specifically designed to process structured PDF content and enable semantic search over the extracted text.

## Features

- Process structured PDF content (text with coordinates and metadata)
- Extract and index text content for semantic search
- Persistent storage of indexed content
- Query interface for semantic search
- Automatic index loading on server startup

## Setup

1. Create a virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # On Windows, use: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

## Running the Service

Start the server:
```bash
python main.py
```

The server will start on `http://localhost:8000`

## API Endpoints

### POST /process-pdf-content
Process and index PDF content. Send a JSON array of PDF content objects:
```json
[
  {
    "left": 72.0,
    "top": 73.0,
    "width": 347.0,
    "height": 99.0,
    "page_number": 1,
    "page_width": 596,
    "page_height": 842,
    "text": "Text content here",
    "type": "Text"
  }
]
```

### POST /query
Query the indexed content. Send a JSON object:
```json
{
  "text": "Query here"
}
```

## Storage

The service automatically persists the index to disk in the `./storage` directory. This means:
- The index survives server restarts
- No need to recompute embeddings
- Faster startup time since embeddings are cached

## API Documentation

Once the server is running, the API documentation can be accessed at:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc` 