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

# Add missing function after OUTPUT_DIR definition

# Define helper function to get the path to the Huridocs result file
def get_huridocs_result_path(filehash):
    """
    Get the path to the Huridocs result file for a given file hash.
    """
    return os.path.join(OUTPUT_DIR, f"{filehash}.json")

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
    """
    Endpoint to chat with a document using the RAG handler
    """
    try:
        # Validate incoming data
        data = request.json
        if not data or 'query' not in data:
            return jsonify({"error": "Missing query in request body"}), 400
        
        query = data['query']
        
        # Check if the file exists in our file cache
        huridocs_json_file = get_huridocs_result_path(filehash)
        
        if not os.path.exists(huridocs_json_file):
            return jsonify({"error": f"Document with hash {filehash} not found or not analyzed yet."}), 404
        
        # Query the document using our RAG handler
        result = rag_handler.query(huridocs_json_file, query)
        
        return jsonify(result)
    
    except Exception as e:
        print(f"Error in chat endpoint: {e}")
        return jsonify({"error": f"Chat processing error: {str(e)}"}), 500

@app.route('/api/summarize/<string:filehash>', methods=['GET'])
def summarize_document_sections(filehash):
    """
    Endpoint to generate summaries for all text segments in a document.
    Returns a mapping of segment IDs to their summaries.
    Supports returning partial results if the parameter 'partial=true' is present.
    Supports resuming generation if the parameter 'resume=true' is present.
    """
    try:
        # Check if client wants partial results or to resume generation
        return_partial = request.args.get('partial', 'false').lower() == 'true'
        resume_generation = request.args.get('resume', 'false').lower() == 'true'
        
        # Check if the file exists in our file cache
        huridocs_json_file = get_huridocs_result_path(filehash)
        
        if not os.path.exists(huridocs_json_file):
            return jsonify({"error": f"Document with hash {filehash} not found or not analyzed yet."}), 404
        
        # Check if we already have summaries cached (partial or complete)
        summary_cache_file = huridocs_json_file.replace('.json', '_summaries.json')
        
        # If client wants partial results and they exist, return them immediately
        if return_partial and os.path.exists(summary_cache_file):
            print(f"Loading partial summaries for {filehash}")
            with open(summary_cache_file, 'r') as f:
                summaries = json.load(f)
            
            # Determine if these are partial or complete results
            is_complete = False
            
            # Check if we have a record of total segments for this file
            total_segments_file = huridocs_json_file.replace('.json', '_total_segments.txt')
            if os.path.exists(total_segments_file):
                try:
                    with open(total_segments_file, 'r') as f:
                        total_segments = int(f.read().strip())
                        is_complete = len(summaries) >= total_segments
                except Exception:
                    is_complete = False
            
            return jsonify({
                "summaries": summaries, 
                "is_partial": not is_complete,
                "count": len(summaries),
                "status": "in_progress" if not is_complete else "complete"
            })
        
        # If complete summaries are requested and exist (and we're not being asked to resume)
        if os.path.exists(summary_cache_file) and not return_partial and not resume_generation:
            print(f"Loading cached summaries for {filehash}")
            with open(summary_cache_file, 'r') as f:
                summaries = json.load(f)
            
            # To better support the frontend progress display, count the total segments
            try:
                with open(huridocs_json_file, 'r') as f:
                    data = json.load(f)
                    
                # Count approximately how many segments are in the document
                total_segments = 0
                if isinstance(data, list):
                    total_segments = len(data)
                elif isinstance(data, dict) and 'pages' in data:
                    for page in data['pages']:
                        if 'texts' in page:
                            total_segments += len(page['texts'])
                        elif 'items' in page:
                            for item in page['items']:
                                if item.get('type') == 'text':
                                    total_segments += 1
                
                # Save total segments count for future reference
                with open(total_segments_file, 'w') as f:
                    f.write(str(total_segments))
                
                is_complete = len(summaries) >= total_segments
                
            except Exception as e:
                print(f"Error counting total segments: {e}")
                is_complete = True  # Assume complete if we can't determine
            
            return jsonify({
                "summaries": summaries,
                "is_partial": not is_complete,
                "count": len(summaries),
                "status": "complete" if is_complete else "in_progress"
            })
        
        # Generate summaries using the RAG handler (or resume generation)
        if resume_generation:
            print(f"Resuming summary generation for {filehash}")
        else:
            print(f"Starting new summary generation for {filehash}")
            
        success, result = rag_handler.load_and_index_with_summaries(huridocs_json_file)
        
        if not success:
            # If there are partial results but the complete generation failed
            if os.path.exists(summary_cache_file):
                with open(summary_cache_file, 'r') as f:
                    partial_results = json.load(f)
                
                if partial_results:
                    return jsonify({
                        "summaries": partial_results,
                        "is_partial": True,
                        "count": len(partial_results),
                        "status": "failed",
                        "error": result
                    })
            
            return jsonify({"error": result}), 500
        
        return jsonify({
            "summaries": result,
            "is_partial": False,
            "count": len(result),
            "status": "complete"
        })
    
    except Exception as e:
        print(f"Error in summarize endpoint: {e}")
        return jsonify({"error": f"Summary generation error: {str(e)}"}), 500

# Add other API routes here later, e.g., for huridocs interaction

if __name__ == '__main__':
    # Runs the app in debug mode locally
    # For production, use a proper WSGI server like Gunicorn or Waitress
    app.run(debug=True, host='0.0.0.0', port=5001) 