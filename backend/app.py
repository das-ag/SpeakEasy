import hashlib
import requests
import os
import json
from flask import Flask, jsonify, request
from dotenv import load_dotenv # Import load_dotenv
from rag_handler import DocumentRAG # Import DocumentRAG

app = Flask(__name__)

# --- Load Environment Variables ---
load_dotenv() # Load variables from .env file
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
if not GOOGLE_API_KEY:
    print("Warning: GOOGLE_API_KEY not found in environment. RAG features will fail.")
    # Or raise an error if RAG is critical: raise ValueError("GOOGLE_API_KEY is required")
# --------------------------------

# --- Cache Configuration ---
# Directory to store persistent JSON results
OUTPUT_DIR = "huridocs_output"
# Ensure the output directory exists
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Simple in-memory cache (acts as a faster layer on top of file cache)
analysis_cache = {}
# -------------------------

# Configuration for Huridocs service
HURIDOCS_URL = os.getenv("HURIDOCS_URL", "http://localhost:5060") # Get from env or use default

# --- Initialize RAG Handler ---
try:
    rag_handler = DocumentRAG(google_api_key=GOOGLE_API_KEY)
except ValueError as e:
    print(f"Error initializing RAG Handler: {e}. Chat features disabled.")
    rag_handler = None # Disable RAG features if key is missing/invalid
except Exception as e:
    print(f"Unexpected error initializing RAG Handler: {e}. Chat features disabled.")
    rag_handler = None
# ---------------------------

@app.route('/health', methods=['GET'])
def health_check():
    """
    Health check endpoint.
    """
    return jsonify({"status": "ok"}), 200

@app.route('/analyze', methods=['POST'])
def analyze_pdf():
    """
    Accepts a PDF file, analyzes it using Huridocs (with file-based
    and in-memory caching), and returns the analysis results.
    """
    if 'file' not in request.files:
        return jsonify({"error": "No file part in the request"}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    if file and file.filename.lower().endswith('.pdf'):
        try:
            pdf_content = file.read()
            pdf_hash = hashlib.sha256(pdf_content).hexdigest()
            output_filepath = os.path.join(OUTPUT_DIR, f"{pdf_hash}.json")

            # 1. Check in-memory cache first
            if pdf_hash in analysis_cache:
                print(f"In-memory cache hit for hash: {pdf_hash[:8]}...")
                return jsonify(analysis_cache[pdf_hash]), 200

            # 2. Check file cache
            if os.path.exists(output_filepath):
                print(f"File cache hit for hash: {pdf_hash[:8]}...")
                try:
                    with open(output_filepath, 'r') as f:
                        analysis_result = json.load(f)
                    # Load into memory cache for faster access next time
                    analysis_cache[pdf_hash] = analysis_result
                    return jsonify(analysis_result), 200
                except json.JSONDecodeError:
                    print(f"Error decoding JSON from file cache: {output_filepath}. Re-analyzing.")
                except Exception as e:
                    print(f"Error reading from file cache {output_filepath}: {e}. Re-analyzing.")

            
            print(f"Cache miss for hash: {pdf_hash[:8]}... Calling Huridocs.")
            files_for_huridocs = {'file': (file.filename, pdf_content, 'application/pdf')}
            # Increase timeout to 1 hour (3600 seconds) for potentially long analyses
            response = requests.post(HURIDOCS_URL, files=files_for_huridocs, timeout=3600)
            response.raise_for_status()
            analysis_result = response.json()

            # 4. Store result in file cache
            try:
                with open(output_filepath, 'w') as f:
                    json.dump(analysis_result, f, indent=2) # Save with indentation for readability
                print(f"Stored result in file cache: {output_filepath}")
            except Exception as e:
                print(f"Error writing to file cache {output_filepath}: {e}")
                # Continue anyway, but log the error

            # 5. Store result in memory cache
            analysis_cache[pdf_hash] = analysis_result
            print(f"Stored result in in-memory cache for hash: {pdf_hash[:8]}...")

            return jsonify(analysis_result), 200

        except requests.exceptions.Timeout:
             print(f"Timeout calling Huridocs service for hash {pdf_hash[:8]}...")
             # No result to cache on timeout
             return jsonify({"error": "Analysis service timed out"}), 504 # Gateway Timeout
        except requests.exceptions.RequestException as e:
            print(f"Error calling Huridocs service: {e}")
            status_code = e.response.status_code if e.response is not None else 503
            error_detail = str(e)
            if e.response is not None:
                try:
                    error_detail = e.response.json().get('error', str(e))
                except requests.exceptions.JSONDecodeError:
                     error_detail = e.response.text
            # No result to cache on request error
            return jsonify({"error": f"Could not connect to or get valid response from analysis service: {error_detail}"}), status_code
        except Exception as e:
            print(f"Error processing PDF: {e}")
            # No result to cache on internal error
            return jsonify({"error": f"An internal server error occurred: {e}"}), 500
    else:
        return jsonify({"error": "Invalid file type, only PDF is allowed"}), 400

# --- RAG Chat Endpoint ---
@app.route('/api/chat/<string:filehash>', methods=['POST'])
def chat_with_document(filehash):
    print(f"\n--- Entered /api/chat/{filehash} endpoint ---")
    """
    Handles chat queries for a specific, previously analyzed document.
    Expects JSON: {"query": "user's question"}
    Uses the filehash (SHA256 of the original PDF) to find the JSON analysis.
    """
    if rag_handler is None:
        return jsonify({"error": "Chat features are disabled due to configuration error."}), 503

    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    query = data.get('query')

    if not query:
        return jsonify({"error": "Missing 'query' in request body"}), 400

    # Construct the path to the analyzed JSON file
    json_filename = f"{filehash}.json"
    json_filepath = os.path.join(OUTPUT_DIR, json_filename)

    # --- Debugging --- 
    print(f"[Chat Endpoint Debug] CWD: {os.getcwd()}")
    print(f"[Chat Endpoint Debug] Checking for file at: {os.path.abspath(json_filepath)}")
    # -----------------

    if not os.path.exists(json_filepath):
        print(f"[Chat Endpoint Debug] File NOT found at {os.path.abspath(json_filepath)}.") # Add log here
        return jsonify({"error": f"Analysis file for hash {filehash} not found. Please analyze the PDF first."}), 404

    try:
        # Use the RAG handler to query the document
        # The handler manages loading/indexing internally
        result = rag_handler.query(json_filepath, query)
        
        if "error" in result:
             # Handle errors reported by the RAG handler itself
             status_code = 500 # Internal Server Error by default
             if "not found or failed to index" in result["error"]:
                  status_code = 404 # Not Found
             return jsonify(result), status_code
        
        # Add the query to the response for context
        result["user_query"] = query
        return jsonify(result), 200

    except Exception as e:
        # Catch unexpected errors during the query process
        print(f"Unexpected error during chat query for {filehash}: {e}")
        return jsonify({"error": "An unexpected error occurred processing your chat request."}), 500
# -----------------------

# Add other API routes here later, e.g., for huridocs interaction

if __name__ == '__main__':
    # Runs the app in debug mode locally
    # For production, use a proper WSGI server like Gunicorn or Waitress
    app.run(debug=True, host='0.0.0.0', port=5001) 