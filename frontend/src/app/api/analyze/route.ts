import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

// Define the expected structure for the Huridocs response
interface SegmentBox {
  left: number;
  top: number;
  width: number;
  height: number;
  page_number: number;
  page_width: number;
  page_height: number;
  text: string;
  type: string;
}

// Define the URL for your Flask backend
const BACKEND_URL = 'http://localhost:5001/analyze'; // Ensure this is correct

export async function POST(request: NextRequest) {
  // Optional: Keep a client-side timeout if desired, but backend handles huridocs timeout
  // const requestTimeout = 240000; 

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    // Note: The 'fast' parameter is no longer directly used here,
    // as the backend doesn't currently support it. 
    // If needed, the backend API would have to be updated to accept and forward it.
    // const fastMode = formData.get('fast') === 'true';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json({ error: 'Invalid file type. Only PDFs are accepted.' }, { status: 400 });
    }

    // Prepare FormData to send to the Flask backend
    // The backend expects a field named 'file'
    const backendFormData = new FormData();
    backendFormData.append('file', file, file.name);

    console.log(`Forwarding analysis request for ${file.name} to backend: ${BACKEND_URL}`);

    // Use axios to send the file to the Flask backend
    const backendResponse = await axios.post<SegmentBox[]>(BACKEND_URL, backendFormData, {
      headers: {
        // Let axios set the Content-Type for FormData
      },
      // Consider backend timeout is primary, but keep a safety timeout?
      // timeout: requestTimeout,
    });

    console.log(`Backend response status: ${backendResponse.status}`);

    // Return the successful analysis result from the backend response
    return NextResponse.json(backendResponse.data);

  } catch (error) {
    console.error('Error calling backend analysis API:', error);

    let errorMessage = 'An unexpected error occurred while calling the backend';
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
          statusCode = 503;
      } else if (error.code === 'ECONNABORTED' || statusCode === 504) {
        errorMessage = 'Request to backend service timed out.';
        statusCode = 504; // Gateway Timeout
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    return NextResponse.json({ error: errorMessage }, { status: statusCode });
  }
} 