import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios'; // Import axios

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

export async function POST(request: NextRequest) {
  const requestTimeout = 240000; // 240 seconds timeout (4 minutes)

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fastMode = formData.get('fast') === 'true';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json({ error: 'Invalid file type. Only PDFs are accepted.' }, { status: 400 });
    }

    // Prepare form data for axios
    const huridocsFormData = new FormData();

    // Convert the File (Blob) to a Buffer for axios, including the filename
    // This is often necessary when forwarding files server-side with FormData
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    huridocsFormData.append('file', new Blob([fileBuffer]), file.name);

    if (fastMode) {
      huridocsFormData.append('fast', 'true');
    }

    const huridocsUrl = 'http://127.0.0.1:5060';

    console.log(`Forwarding request to Huridocs via axios at ${huridocsUrl} ${fastMode ? 'with fast=true' : ''} (Timeout: ${requestTimeout / 1000}s)`);

    // Use axios to make the request
    const huridocsResponse = await axios.post<SegmentBox[]>(huridocsUrl, huridocsFormData, {
      headers: {
        // Let axios set the Content-Type header with the correct boundary for FormData
        // 'Content-Type': 'multipart/form-data', // This might be needed depending on axios version/behavior
      },
      // Max content length might need adjustment for large PDFs
      // maxBodyLength: Infinity,
      // maxContentLength: Infinity,
    });

    console.log(`Huridocs response status (axios): ${huridocsResponse.status}`);

    // axios throws an error for non-2xx responses, so no need to check huridocsResponse.ok

    // Return the successful analysis result from axios response data
    return NextResponse.json(huridocsResponse.data);

  } catch (error) {
    console.error('Error in /api/analyze:', error);

    let errorMessage = 'An unexpected error occurred';
    let statusCode = 500;

    if (axios.isAxiosError(error)) {
      console.error('Axios error details:', error.response?.data);
      errorMessage = error.response?.data?.error || error.response?.data?.detail || error.message;
      statusCode = error.response?.status || 500;

      if (error.code === 'ECONNABORTED') {
        errorMessage = `Request to backend service timed out after ${requestTimeout / 1000} seconds.`;
        statusCode = 504; // Gateway Timeout
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    return NextResponse.json({ error: errorMessage }, { status: statusCode });
  }
} 