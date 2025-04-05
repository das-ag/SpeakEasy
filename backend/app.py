from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health_check():
    """
    Health check endpoint.
    """
    return jsonify({"status": "ok"}), 200

# Add other API routes here later, e.g., for huridocs interaction

if __name__ == '__main__':
    # Runs the app in debug mode locally
    # For production, use a proper WSGI server like Gunicorn or Waitress
    app.run(debug=True, host='0.0.0.0', port=5001) # Using port 5001 to avoid conflict with frontend (usually 3000) 