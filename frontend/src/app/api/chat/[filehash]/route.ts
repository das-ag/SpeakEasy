import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

// Define the base URL for your Flask backend
const BACKEND_BASE_URL = 'http://localhost:5001'; // Ensure this matches your Flask server

export async function POST(
  request: NextRequest,
  { params }: { params: { filehash: string } }
) {
  try {
    const { filehash } = params;
    
    // Validate the filehash (should be a valid SHA-256 hash)
    if (!filehash || !/^[a-f0-9]{64}$/i.test(filehash)) {
      return NextResponse.json(
        { error: 'Invalid file hash format.' },
        { status: 400 }
      );
    }

    // Get the JSON data from the request
    let requestData;
    try {
      requestData = await request.json();
    } catch (jsonError) {
      return NextResponse.json(
        { error: 'Invalid JSON in request body.' },
        { status: 400 }
      );
    }

    // Verify query was provided
    if (!requestData.query) {
      return NextResponse.json(
        { error: 'Missing "query" field in request body.' },
        { status: 400 }
      );
    }

    // Construct the backend URL
    const backendUrl = `${BACKEND_BASE_URL}/api/chat/${filehash}`;
    console.log(`Forwarding chat request to backend: ${backendUrl}`);

    // Forward the request to the Flask backend
    const backendResponse = await axios.post(backendUrl, requestData, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    console.log(`Backend chat response status: ${backendResponse.status}`);

    // Return the successful chat response from the backend
    return NextResponse.json(backendResponse.data);

  } catch (error) {
    console.error('Error calling backend chat API:', error);

    let errorMessage = 'An unexpected error occurred while calling the backend chat API';
    let statusCode = 500;

    if (axios.isAxiosError(error)) {
      // Log the detailed error from the backend if available
      console.error('Backend Axios error details:', error.response?.data);
      
      // Prefer the error message from the backend response
      errorMessage = error.response?.data?.error || error.response?.data?.detail || error.message;
      
      // Use the status code from the backend response
      statusCode = error.response?.status || 503; // Use 503 Service Unavailable if status is missing

      if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused. Is the backend server running?';
        statusCode = 503; // Service Unavailable
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    return NextResponse.json({ error: errorMessage }, { status: statusCode });
  }
} 