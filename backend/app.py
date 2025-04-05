import hashlib
import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

# Simple in-memory cache (replace with more robust caching if needed)
analysis_cache = {}

# Configuration for Huridocs service
HURIDOCS_URL = "http://localhost:5060" # Default URL for huridocs/pdf-document-layout-analysis

@app.route('/health', methods=['GET'])
def health_check():
    """
    Health check endpoint.
    """
    return jsonify({"status": "ok"}), 200

@app.route('/analyze', methods=['POST'])
def analyze_pdf():
    """
    Accepts a PDF file, analyzes it using Huridocs (with caching),
    and returns the analysis results.
    """
    if 'file' not in request.files:
        return jsonify({"error": "No file part in the request"}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    if file and file.filename.lower().endswith('.pdf'):
        try:
            # Read content once for hashing and sending
            pdf_content = file.read()
            # File stream position might be at the end after read(), 
            # reset if needed (though requests handles bytes directly)
            # file.seek(0) 

            # Calculate hash for caching
            pdf_hash = hashlib.sha256(pdf_content).hexdigest()

            # Check cache
            if pdf_hash in analysis_cache:
                print(f"Cache hit for hash: {pdf_hash[:8]}...")
                return jsonify(analysis_cache[pdf_hash]), 200

            print(f"Cache miss for hash: {pdf_hash[:8]}... Calling Huridocs.")

            # Prepare file data for Huridocs request
            files_for_huridocs = {'file': (file.filename, pdf_content, 'application/pdf')}

            # Call Huridocs service
            # Consider adding timeout
            response = requests.post(HURIDOCS_URL, files=files_for_huridocs, timeout=180) # Increased timeout for potentially long analysis
            response.raise_for_status() # Raise an exception for bad status codes (4xx or 5xx)

            analysis_result = response.json()

            # Store result in cache
            analysis_cache[pdf_hash] = analysis_result
            print(f"Stored result in cache for hash: {pdf_hash[:8]}...")

            return jsonify(analysis_result), 200

        except requests.exceptions.Timeout:
             print(f"Timeout calling Huridocs service for hash {pdf_hash[:8]}...")
             return jsonify({"error": "Analysis service timed out"}), 504 # Gateway Timeout
        except requests.exceptions.RequestException as e:
            print(f"Error calling Huridocs service: {e}")
            # Provide more specific error based on status code if possible
            status_code = e.response.status_code if e.response is not None else 503
            error_detail = str(e)
            if e.response is not None:
                try:
                    error_detail = e.response.json().get('error', str(e))
                except requests.exceptions.JSONDecodeError:
                     error_detail = e.response.text # Use raw text if not JSON
            return jsonify({"error": f"Could not connect to or get valid response from analysis service: {error_detail}"}), status_code
        except Exception as e:
            print(f"Error processing PDF: {e}")
            return jsonify({"error": f"An internal server error occurred: {e}"}), 500
    else:
        return jsonify({"error": "Invalid file type, only PDF is allowed"}), 400

# Add other API routes here later, e.g., for huridocs interaction

if __name__ == '__main__':
    # Runs the app in debug mode locally
    # For production, use a proper WSGI server like Gunicorn or Waitress
    app.run(debug=True, host='0.0.0.0', port=5001) # Using port 5001 to avoid conflict with frontend (usually 3000) 