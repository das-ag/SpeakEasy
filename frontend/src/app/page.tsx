"use client";

import { useState, ChangeEvent, FormEvent, useEffect, useRef, MouseEvent } from 'react';
// Import react-pdf components and configure worker
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Move worker configuration into a useEffect hook
// pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.js`; // Moved below

// Define an interface for the expected analysis result structure
// Based on the Huridocs README
interface SegmentBox {
  left: number;
  top: number;
  width: number;
  height: number;
  page_number: number;
  page_width: number;
  page_height: number;
  text: string;
  type: string; // "Caption", "Footnote", "Formula", "List item", "Page footer", "Page header", "Picture", "Section header", "Table", "Text", "Title"
}

// Interface for chat messages
interface ChatMessage {
  sender: 'user' | 'bot';
  text: string;
  sources?: any[]; // Optional: To store source document snippets
}

// Helper function to get a color based on segment type
const getTypeColor = (type: string): string => {
  switch (type.toLowerCase()) {
    case 'title': return 'rgba(255, 0, 0, 0.2)'; // Red
    case 'section header': return 'rgba(255, 165, 0, 0.2)'; // Orange
    case 'text': return 'rgba(0, 0, 255, 0.1)'; // Blue
    case 'table': return 'rgba(0, 128, 0, 0.2)'; // Green
    case 'picture': return 'rgba(128, 0, 128, 0.2)'; // Purple
    case 'list item': return 'rgba(0, 255, 255, 0.2)'; // Cyan
    case 'page header': return 'rgba(169, 169, 169, 0.2)'; // Dark Gray
    case 'page footer': return 'rgba(169, 169, 169, 0.2)'; // Dark Gray
    case 'footnote': return 'rgba(210, 180, 140, 0.2)'; // Tan
    case 'formula': return 'rgba(255, 20, 147, 0.2)'; // Deep Pink
    case 'caption': return 'rgba(128, 128, 0, 0.2)'; // Olive
    default: return 'rgba(128, 128, 128, 0.2)'; // Gray
  }
};

// Helper function to calculate SHA-256 hash
async function calculateSHA256(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// localStorage keys
// REMOVED: const LS_RESULT_PREFIX = 'speakeasy_analysis_result_';
// REMOVED: const LS_NUMPAGES_PREFIX = 'speakeasy_num_pages_'; // Removed as numPages is no longer cached

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null); // Store filename for caching key
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [analysisResult, setAnalysisResult] = useState<SegmentBox[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null); // Ref for the container div
  const [hoveredBox, setHoveredBox] = useState<SegmentBox | null>(null); // Store the box object

  // --- Chat State ---
  const [chatFileHash, setChatFileHash] = useState<string | null>(null);
  const [chatQuery, setChatQuery] = useState<string>("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null); // Ref to scroll chat to bottom

  // Configure worker on component mount
  useEffect(() => {
    // pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.js`; // Moved below
    // Try constructing URL relative to the module's location
    // This often works better with bundlers than assuming a root path
    // try {
    //   const workerUrl = new URL('pdfjs-dist/build/pdf.worker.min.js', import.meta.url).toString();
    //    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    //    console.log('PDF worker path set to:', workerUrl);
    // } catch (error) {
    //     console.error("Failed to set PDF worker path using import.meta.url, falling back to relative path:", error);
    //     // Fallback for environments where import.meta.url might not work as expected
    //      pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.js`;
    //      console.log('PDF worker path set to fallback: /pdf.worker.min.js');
    // }
    // Set the worker path directly, assuming it's served from the public root
    pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;
    console.log('PDF worker path set to:', pdfjs.GlobalWorkerOptions.workerSrc);
  }, []);

  // Clean up the object URL when component unmounts or file changes
  useEffect(() => {
    return () => {
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl);
      }
    };
  }, [fileUrl]);

  // Scroll chat to bottom when history updates
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      const selectedFile = event.target.files[0];
      const currentFileName = selectedFile.name;

      // Clear ALL relevant state for new file
      setFile(selectedFile);
      setFileName(currentFileName);
      setAnalysisResult(null);
      setError(null);
      setChatError(null); // Clear chat error too
      setNumPages(null);
      setChatFileHash(null); // Clear hash for new file
      setChatHistory([]); // Clear chat history
      setChatQuery(""); // Clear chat input
      
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl);
      }
      const newFileUrl = URL.createObjectURL(selectedFile);
      setFileUrl(newFileUrl);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !fileName) {
      setError("Please select a PDF file first.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setChatError(null);
    setAnalysisResult(null);
    setChatFileHash(null); // Clear hash before new analysis
    setChatHistory([]); // Clear chat history

    const formData = new FormData();
    formData.append('file', file);

    try {
      console.log(`Starting analysis for ${fileName}...`);
      // *** USE THE CORRECT BACKEND API URL HERE ***
      // If backend runs on 5001 and frontend on 3000, direct fetch might work
      // but for robustness (e.g., deployment), use a relative path or environment variable.
      // Assuming relative path works if frontend proxy is set up or same origin:
      const analyzeApiUrl = '/api/analyze'; 
      // Or use full URL if needed: const analyzeApiUrl = 'http://localhost:5001/analyze';
      
      const response = await fetch(analyzeApiUrl, { // Use configured URL
        method: 'POST',
        body: formData,
        // Add timeout? Default fetch timeout is long, but consider explicit
      });

      if (!response.ok) {
        let errorMsg = `HTTP error! status: ${response.status}`;
        try {
            const errorData = await response.json();
            errorMsg = errorData.error || errorMsg;
        } catch (jsonError) {
            // If response isn't JSON, use text
            errorMsg = await response.text();
        }
        throw new Error(errorMsg);
      }

      const result: SegmentBox[] = await response.json();
      setAnalysisResult(result);
      console.log(`Analysis successful for ${fileName}. Calculating hash...`);

      // Calculate and store file hash for chat API calls
      const hash = await calculateSHA256(file);
      setChatFileHash(hash);
      console.log(`File hash calculated: ${hash.substring(0, 8)}...`);

    } catch (err) {
      console.error("Analysis error:", err);
      setError(err instanceof Error ? err.message : "An unknown error occurred during analysis.");
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      setFileUrl(null); // Clear file URL on analysis error
      setAnalysisResult(null); // Clear results on error
      setNumPages(null);
      setChatFileHash(null); // Clear hash on error
      setChatHistory([]); // Clear chat history
    } finally {
      setIsLoading(false);
    }
  };

  // Callback for react-pdf Document load success
  function onDocumentLoadSuccess({ numPages: nextNumPages }: { numPages: number }): void {
    setNumPages(nextNumPages);
    
  }

  // Function to handle mouse movement over the PDF container
  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    console.log('handleMouseMove triggered');
    console.log('analysisResult:', analysisResult ? 'Exists' : 'null'); // Log analysisResult status
    console.log('containerRef.current:', containerRef.current ? 'Exists' : 'null'); // Log ref status
    if (!analysisResult || !containerRef.current) {
        console.log('Exiting early: analysisResult or containerRef.current is null.'); // Log if exiting
        return;
    }

    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    // Calculate mouse position relative to the scrolled container content
    const mouseXRelative = event.clientX - containerRect.left; // Relative to container viewport
    const mouseYRelative = event.clientY - containerRect.top; // Relative to container viewport
    const mouseX = mouseXRelative + container.scrollLeft; // Relative to container scrollable content
    const mouseY = mouseYRelative + container.scrollTop; // Relative to container scrollable content

    // Find the currently hovered page element
    let hoveredPageNumber: number | null = null;
    const pageElements = container.querySelectorAll<HTMLDivElement>('.pdf-page-wrapper');
    console.log(`Found ${pageElements.length} page elements.`);

    pageElements.forEach(pageElement => {
        const pageTop = pageElement.offsetTop;
        const pageBottom = pageTop + pageElement.offsetHeight;
        const pageNumAttr = pageElement.getAttribute('data-page-number'); // Get page number for logging

        // Debugging Logs:
        // console.log(`Page ${pageNumAttr}: Top=${pageTop}, Bottom=${pageBottom}, MouseY=${mouseY}`); // Commented out

        // Check if the mouse Y position is within the vertical bounds of this page element
        if (mouseY >= pageTop && mouseY < pageBottom) {
             console.log(`>>> Hovering Page ${pageNumAttr}`); // Keep this one
            if (pageNumAttr) {
                hoveredPageNumber = parseInt(pageNumAttr, 10);
                // Exit the loop once the page is found
                // Note: forEach cannot be broken directly, but this logic works.
                // If performance is critical, a standard for loop could be used.
            }
        }
    });

    // If no page is actively hovered (e.g., in margins), exit
    if (hoveredPageNumber === null) {
        if (hoveredBox !== null) {
             setHoveredBox(null); // Clear hover if mouse moved out of all pages
        }
        return;
    }

    // --- Start: Calculations based on hovered page ---
    const currentPageElement = container.querySelector<HTMLDivElement>(`.pdf-page-wrapper[data-page-number="${hoveredPageNumber}"]`);
    // Find the canvas within the page wrapper
    const canvasElement = currentPageElement?.querySelector('canvas');

    if (!currentPageElement || !canvasElement || canvasElement.offsetWidth <= 0 || canvasElement.offsetHeight <= 0) {
        console.error("Could not find valid page element or canvas for hover calculation.");
        if (hoveredBox !== null) setHoveredBox(null); // Clear hover if calculation fails
        return;
    }

    const renderedWidth = canvasElement.offsetWidth; // Use canvas width
    const renderedHeight = canvasElement.offsetHeight; // Use canvas height
    const pageOffsetTop = currentPageElement.offsetTop;
    const pageOffsetLeft = currentPageElement.offsetLeft;

    // Calculate mouse position relative to the page element's top-left corner
    const mouseXOnPage = mouseX - pageOffsetLeft;
    const mouseYOnPage = mouseY - pageOffsetTop;

    // Calculate mouse position as percentage using consistent aspect ratio
    const mouseXPercent = (mouseXOnPage / renderedWidth) * 100;
    const mouseYPercent = (mouseYOnPage / renderedHeight) * 100; // Use rendered canvas height
    // --- End: Calculations based on hovered page ---

    // Find the smallest box being hovered on the determined page
    let foundBox: SegmentBox | null = null; // Store the found box object
    let minArea = Infinity;

    analysisResult.forEach((box) => {
        if (box.page_number === hoveredPageNumber) { // Use the dynamically found page number
            // Get the box's percentage dimensions (used for styling)
            const leftPercent = (box.left / box.page_width) * 100;
            const topPercent = (box.top / box.page_height) * 100;
            const widthPercent = (box.width / box.page_width) * 100;
            const heightPercent = (box.height / box.page_height) * 100;

            // Calculate percentage area for smallest box comparison
            const areaPercent = widthPercent * heightPercent;

            // Check if the mouse percentage position is inside the box's percentage boundaries
            if (
                mouseXPercent >= leftPercent &&
                mouseXPercent <= leftPercent + widthPercent &&
                mouseYPercent >= topPercent &&
                mouseYPercent <= topPercent + heightPercent
            )
            {
                // Use percentage area for comparison
                if (areaPercent < minArea) {
                    minArea = areaPercent;
                    foundBox = box; // Set the found box object
                }
            }
        }
    });

    // Log the final key before setting state
    console.log(`Final foundBox: ${foundBox ? 'Exists' : 'null'}, Previous hoveredBox: ${hoveredBox ? 'Exists' : 'null'}`); // Simplified log

    // Update state if the hovered box object has changed
    if (foundBox !== hoveredBox) {
        setHoveredBox(foundBox);
    }
  };

  const handleMouseLeave = () => {
    setHoveredBox(null);
  };

  const handleChatSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chatQuery.trim() || !chatFileHash || isChatLoading) {
        return; // Don't submit empty queries or while loading
    }

    const userMessage: ChatMessage = { sender: 'user', text: chatQuery };
    setChatHistory(prev => [...prev, userMessage]);
    setChatQuery(""); // Clear input immediately
    setIsChatLoading(true);
    setChatError(null);

    try {
        console.log(`Sending chat query for hash ${chatFileHash.substring(0,8)}...: ${userMessage.text}`);
        // *** USE THE CORRECT BACKEND API URL HERE ***
        const chatApiUrl = `/api/chat/${chatFileHash}`; 
        // Or use full URL: const chatApiUrl = `http://localhost:5001/api/chat/${chatFileHash}`;

        const response = await fetch(chatApiUrl, { // Use configured URL
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: userMessage.text }),
        });

        if (!response.ok) {
            // Read the body ONCE as text first
            const errorText = await response.text();
            let errorMsg = `Chat API error! status: ${response.status}`;
             try {
                // Try to parse the text as JSON
                const errorData = JSON.parse(errorText);
                errorMsg = errorData.error || errorMsg;
            } catch (parseError) { 
                 // If parsing fails, use the raw text (it might not be JSON)
                 errorMsg = errorText || errorMsg; 
            }
            throw new Error(errorMsg);
        }

        const result = await response.json();
        console.log("Chat API response received:", result);

        const botMessage: ChatMessage = {
            sender: 'bot',
            text: result.response,
            sources: result.sources // Include sources if available
        };
        setChatHistory(prev => [...prev, botMessage]);

    } catch (err) {
        console.error("Chat error:", err);
        const errorText = err instanceof Error ? err.message : "An unknown error occurred during chat.";
        setChatError(errorText);
        // Optionally add an error message to chat history
        setChatHistory(prev => [...prev, {sender: 'bot', text: `Error: ${errorText}`}]);
    } finally {
        setIsChatLoading(false);
    }

  };

  return (
    <div className="container mx-auto p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-4">SpeakEasy PDF Analyzer</h1>
        <p className="text-gray-600">Upload a PDF to analyze its layout and content structure.</p>
      </header>

      <main>
        <form onSubmit={handleSubmit} className="mb-8 p-6 border rounded-lg shadow-sm bg-white">
          <div className="mb-4">
            <label htmlFor="pdf-upload" className="block text-sm font-medium text-gray-700 mb-2">
              Choose PDF File
            </label>
            <input
              id="pdf-upload"
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
          </div>
          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={!file || isLoading}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out"
            >
              {isLoading ? 'Analyzing...' : 'Analyze PDF'}
            </button>
          </div>
        </form>

        {isLoading && (
          <div className="flex justify-center items-center my-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="ml-3 text-gray-600">Processing PDF, please wait...</p>
          </div>
        )}

        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-6" role="alert">
            <strong className="font-bold">Error:</strong>
            <span className="block sm:inline"> {error}</span>
          </div>
        )}

        {/* PDF Rendering and Bounding Box Area */}
        {/* Render Document container as soon as fileUrl is available and not loading analysis */}
        {fileUrl && !isLoading && (
          <div className="mt-8 border rounded-lg shadow-sm pdf-container bg-gray-200 p-4 mx-auto">
            <div className="flex justify-between items-center mb-4">
              {/* Adjust title based on whether analysis is done */}
              <h2 className="text-2xl font-semibold text-gray-900">{analysisResult ? "Analyzed PDF" : "PDF Preview"}</h2>
            </div>
            {/* Show analysis summary only when results are available */}
            {analysisResult && <p className="mb-4 text-gray-700">Found {analysisResult.length} segments across {numPages ?? '...'} pages.</p>}
            
            <div
              ref={containerRef}
              className="overflow-auto max-h-[80vh] border relative"
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            >
              {/* Re-add style to force canvas aspect ratio */}
              <style jsx global>{`
                .pdf-page-wrapper canvas {
                  height: auto !important;
                  max-width: 100%; /* Ensure it doesn't overflow */
                }
              `}</style>
              <Document
                file={fileUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={(err) => {
                  console.error("PDF Load error:", err);
                  setError(`Failed to load PDF: ${err.message}`);
                  setFileUrl(null); // Clear URL on load error
                }}
                loading="Loading PDF Preview..."
              >
                {/* Render pages only when numPages is known */}
                {numPages && Array.from(new Array(numPages), (el, index) => {
                  const pageNumber = index + 1;
                  return (
                    <div
                      key={`page_container_${pageNumber}`}
                      className="pdf-page-wrapper w-fit mx-auto max-w-5xl"
                      data-page-number={pageNumber}
                      style={{ position: 'relative', marginBottom: '1rem' }}
                    >
                      <Page
                        key={`page_${pageNumber}`}
                        pageNumber={pageNumber}
                      />
                      {/* Overlay Bounding boxes only if analysisResult is available */}
                      {analysisResult && analysisResult
                        .filter(box => box.page_number === pageNumber)
                        .map((box, boxIndex) => {
                          // Use the same unique key generation as in handleMouseMove
                          // Compare actual box object with the one in state
                          const isHovered = hoveredBox === box;

                          const leftPercent = (box.left / box.page_width) * 100;
                          const topPercent = (box.top / box.page_height) * 100;
                          const widthPercent = (box.width / box.page_width) * 100;
                          const heightPercent = (box.height / box.page_height) * 100;

                          return (
                            <div
                              key={`render_box_${pageNumber}_${boxIndex}`} // Use map index for stable React key
                              title={`${box.type}: ${box.text.substring(0, 100)}...`}
                              style={{
                                position: 'absolute',
                                left: `${leftPercent}%`,
                                top: `${topPercent}%`,
                                width: `${widthPercent}%`,
                                height: `${heightPercent}%`,
                                border: `2px solid ${getTypeColor(box.type).replace('0.2', '1.0')}`,
                                backgroundColor: getTypeColor(box.type),
                                boxSizing: 'border-box',
                                pointerEvents: 'none', // Keep this active
                                transition: 'filter 0.15s ease-in-out, transform 0.15s ease-in-out', // Add transform transition
                                filter: isHovered ? 'brightness(125%)' : 'brightness(100%)', // Apply brightness
                                transform: isHovered ? 'scale(1.02)' : 'scale(1)', // RE-ADD scale
                                transformOrigin: 'center center', // Ensure scaling originates from the center
                                zIndex: isHovered ? 10 : 1, // Bring hovered box slightly forward
                              }}
                            >
                              <span style={{
                                position: 'absolute',
                                top: '-18px',
                                left: '0',
                                backgroundColor: getTypeColor(box.type).replace('0.2', '0.8'),
                                color: 'white',
                                padding: '1px 3px',
                                fontSize: '10px',
                                whiteSpace: 'nowrap',
                                zIndex: 1,
                                // pointerEvents: 'none', // Label should also be non-interactive
                              }}>
                                {box.type}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
              </Document>
            </div>
          </div>
        )}

        {/* --- Chat Interface --- */}
        {analysisResult && chatFileHash && (
          <div className="w-full max-w-2xl mt-8 bg-white p-4 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">Chat with Document ({fileName})</h2>
            
            {/* Chat History Display */}
            <div className="h-64 overflow-y-auto border border-gray-200 rounded p-3 mb-4 bg-gray-50">
              {chatHistory.map((msg, index) => (
                <div key={index} className={`mb-3 ${
                    msg.sender === 'user' ? 'text-right' : 'text-left'
                  }`}>
                  <span className={`inline-block p-2 rounded-lg ${
                      msg.sender === 'user' 
                      ? 'bg-blue-500 text-white' 
                      : 'bg-gray-200 text-gray-800'
                    }`}>
                    {msg.text}
                    {/* Optional: Display sources for bot messages */}
                    {msg.sender === 'bot' && msg.sources && msg.sources.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-gray-300 text-xs text-left">
                        <p className="font-semibold mb-1">Sources:</p>
                        <ul>
                          {msg.sources.map((source, s_idx) => (
                             <li key={s_idx} title={JSON.stringify(source.metadata)} className="mb-1 p-1 bg-gray-100 rounded truncate hover:whitespace-normal">
                                  [...{source.metadata.page_number ? `P${source.metadata.page_number}` : 'N/A'}] {source.content_preview}
                              </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </span>
                </div>
              ))}
              {/* Loading indicator for chat response */}
              {isChatLoading && (
                  <div className="text-left mb-3">
                       <span className="inline-block p-2 rounded-lg bg-gray-200 text-gray-500 animate-pulse">
                          Thinking...
                       </span>
                  </div>
              )}
               {/* Error display for chat */}
              {chatError && (
                  <div className="text-left mb-3">
                       <span className="inline-block p-2 rounded-lg bg-red-100 text-red-700">
                          Error: {chatError}
                       </span>
                  </div>
              )}
              {/* Dummy div to ensure scrolling to bottom */}
              <div ref={chatEndRef} /> 
            </div>

            {/* Chat Input Form */}
            <form onSubmit={handleChatSubmit} className="flex items-center">
              <input
                type="text"
                value={chatQuery}
                onChange={(e) => setChatQuery(e.target.value)}
                placeholder="Ask a question about the document..."
                className="flex-grow shadow appearance-none border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline mr-2"
                disabled={isChatLoading}
                required
              />
              <button
                type="submit"
                disabled={isChatLoading || !chatQuery.trim()}
                className={`bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline ${
                  isChatLoading || !chatQuery.trim() ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                Send
              </button>
            </form>
          </div>
        )}

      </main>

      <footer className="mt-12 text-center text-gray-500 text-sm">
        Powered by Next.js and Huridocs
      </footer>
    </div>
  );
}
