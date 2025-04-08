import { NextRequest, NextResponse } from 'next/server';

// Define the URL of your Flask backend's query endpoint
const BACKEND_QUERY_URL = process.env.BACKEND_URL ? `${process.env.BACKEND_URL}/query` : 'http://localhost:5001/query';

export async function POST(request: NextRequest) {
  console.log('[API /api/query] Received query request');
  try {
    // 1. Get the query from the incoming request body
    const body = await request.json();
    const queryText = body.query;

    if (!queryText || typeof queryText !== 'string' || !queryText.trim()) {
      console.log('[API /api/query] Invalid query in request body:', body);
      return NextResponse.json({ error: "Invalid 'query' in request body. Must be a non-empty string." }, { status: 400 });
    }

    console.log(`[API /api/query] Forwarding query to backend: ${queryText.substring(0, 50)}...`);

    // 2. Forward the query to the Flask backend
    const backendResponse = await fetch(BACKEND_QUERY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: queryText }), // Send in the expected format
    });

    // 3. Handle the response from the backend
    const responseData = await backendResponse.json();

    if (!backendResponse.ok) {
      // If backend returned an error, forward it
      console.error(`[API /api/query] Backend returned error (${backendResponse.status}):`, responseData);
      return NextResponse.json(
        { error: responseData.error || `Backend error: ${backendResponse.statusText}` },
        { status: backendResponse.status }
      );
    }

    console.log('[API /api/query] Successfully received response from backend.');
    // 4. Return the successful backend response to the frontend client
    return NextResponse.json(responseData, { status: 200 });

  } catch (error) {
    console.error('[API /api/query] Error processing query request:', error);
    let errorMessage = "An unknown error occurred.";
    if (error instanceof Error) {
        errorMessage = error.message;
    }
    // Handle JSON parsing errors or other unexpected issues
    if (error instanceof SyntaxError) {
         errorMessage = "Invalid JSON received from frontend.";
         return NextResponse.json({ error: errorMessage }, { status: 400 });
    }
    // Handle fetch errors (e.g., backend unreachable)
    if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
        errorMessage = "Could not connect to the backend RAG service.";
         return NextResponse.json({ error: errorMessage }, { status: 503 }); // Service Unavailable
    }

    return NextResponse.json({ error: `Internal Server Error: ${errorMessage}` }, { status: 500 });
  }
} 