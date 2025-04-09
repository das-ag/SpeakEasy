import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

// Define the base URL for your Flask backend
const BACKEND_BASE_URL = 'http://localhost:5001'; // Ensure this matches your Flask server

export async function GET(
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

    // Check if partial results are requested and if we should resume generation
    const { searchParams } = new URL(request.url);
    const partial = searchParams.get('partial') === 'true';
    const resume = searchParams.get('resume') === 'true';

    // Construct the backend URL with both parameters if provided
    let backendUrl = `${BACKEND_BASE_URL}/api/summarize/${filehash}`;
    const queryParams = [];
    
    if (partial) queryParams.push('partial=true');
    if (resume) queryParams.push('resume=true');
    
    if (queryParams.length > 0) {
      backendUrl += `?${queryParams.join('&')}`;
    }
    
    console.log(`Fetching document summaries from backend: ${backendUrl}`);

    // Forward the request to the Flask backend
    const backendResponse = await axios.get(backendUrl, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    console.log(`Backend summaries response status: ${backendResponse.status}`);

    // Return the successful summaries response from the backend
    return NextResponse.json(backendResponse.data);

  } catch (error) {
    console.error('Error calling backend summarize API:', error);

    let errorMessage = 'An unexpected error occurred while calling the backend summarize API';
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