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
  id?: string; // Add unique identifier for tracking expanded state
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
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set()); // Track expanded sources

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
      
      console.log("File changed:", { fileName: currentFileName, fileUrl: newFileUrl });
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
    console.log(`PDF loaded successfully with ${nextNumPages} pages`);
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

    const userMessage: ChatMessage = { 
      sender: 'user', 
      text: chatQuery,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` // Add unique ID
    };
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
            sources: result.sources, // Include sources if available
            id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` // Add unique ID
        };
        setChatHistory(prev => [...prev, botMessage]);

    } catch (err) {
        console.error("Chat error:", err);
        const errorText = err instanceof Error ? err.message : "An unknown error occurred during chat.";
        setChatError(errorText);
        // Optionally add an error message to chat history
        setChatHistory(prev => [...prev, {
          sender: 'bot', 
          text: `Error: ${errorText}`,
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` // Add unique ID
        }]);
    } finally {
        setIsChatLoading(false);
    }
  };

  // Toggle source expansion for a specific message
  const toggleSourceExpansion = (messageId: string) => {
    setExpandedSources(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  };

  return (
    <main className="flex min-h-screen flex-col p-4 md:p-8 lg:p-12 bg-gray-50">
      {/* Debug state display - remove after fixing */}
      <div className="fixed bottom-1 right-1 bg-black bg-opacity-80 text-white text-xs p-2 rounded z-50">
        <p>Debug: File: {fileName ? "✅" : "❌"}, FileURL: {fileUrl ? "✅" : "❌"}, Pages: {numPages || "None"}</p>
      </div>
      
      {/* Header - Title in top left and larger */}
      <div className="w-full mb-8">
        <h1 className="text-4xl md:text-5xl font-bold text-gray-800">SpeakEasy</h1>
      </div>

      {/* Main content container - Increase max width to accommodate all panels */}
      <div className="w-full max-w-[95vw] flex flex-col">
        {/* --- File Upload Form --- Left aligned */}
        <form onSubmit={handleSubmit} className="w-full max-w-lg bg-white p-6 rounded-lg shadow mb-8 self-start">
          <div className="mb-4">
            <label htmlFor="pdf-upload" className="block text-gray-700 text-sm font-bold mb-2">
              Upload PDF Document:
            </label>
            <input
              id="pdf-upload"
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
              required
            />
          </div>
          <button
            type="submit"
            disabled={isLoading || !file}
            className={`w-full bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline ${
              isLoading || !file ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {isLoading ? 'Analyzing...' : 'Analyze Document'}
          </button>
          {error && <p className="text-red-500 text-xs italic mt-4">Error: {error}</p>}
        </form>

        {/* --- PDF Viewer and Chat Container */}
        {fileUrl ? (
          <div className="w-full flex flex-col lg:flex-row gap-6">
            {/* Metadata Panel - Slightly reduce width */}
            <div className="w-full lg:w-1/6 h-[70vh] bg-white p-4 rounded-lg shadow-md border border-gray-200 flex flex-col overflow-auto">
              <h2 className="text-lg font-bold mb-4 text-gray-900">Document Elements</h2>
              {/* Current hover information */}
              <div className="border-b border-gray-300 pb-3 mb-3">
                <p className="font-medium text-gray-900">Currently Hovering:</p>
                {hoveredBox ? (
                  <div className="mt-2">
                    <div className="flex items-center mb-1">
                      <span className="font-semibold text-sm text-gray-900">Type:</span>
                      <span 
                        className="ml-2 px-2 py-1 text-xs rounded-md font-medium text-gray-900 border"
                        style={{
                          backgroundColor: getTypeColor(hoveredBox.type),
                          borderColor: getTypeColor(hoveredBox.type).replace('0.2', '0.5').replace('0.1', '0.4')
                        }}
                      >
                        {hoveredBox.type}
                      </span>
                    </div>
                    <div className="mt-2">
                      <span className="font-semibold text-sm text-gray-900">Content:</span>
                      <p className="text-xs mt-1 bg-white p-2 rounded whitespace-pre-wrap max-h-40 overflow-y-auto border border-gray-300 text-gray-900 shadow-sm">
                        {hoveredBox.text}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-600 italic mt-1">
                    Hover over the PDF to view element details...
                  </p>
                )}
              </div>
              
              {/* Document statistics */}
              {analysisResult && (
                <div>
                  <h3 className="font-medium text-gray-900 mb-2">Document Statistics:</h3>
                  <ul className="text-sm space-y-2 text-gray-800">
                    <li><span className="font-semibold">Pages:</span> {numPages}</li>
                    <li><span className="font-semibold">Elements:</span> {analysisResult.length}</li>
                    {/* Count types */}
                    {(() => {
                      const typeCounts: {[key: string]: number} = {};
                      analysisResult.forEach(box => {
                        typeCounts[box.type] = (typeCounts[box.type] || 0) + 1;
                      });
                      return (
                        <>
                          {Object.entries(typeCounts).map(([type, count]) => (
                            <li key={type} className="ml-3 flex items-center">
                              <span 
                                className="inline-block w-3 h-3 mr-1 rounded-sm border border-gray-400"
                                style={{ backgroundColor: getTypeColor(type) }}
                              />
                              <span className="text-gray-800">{type}: {count}</span>
                            </li>
                          ))}
                        </>
                      );
                    })()}
                  </ul>
                </div>
              )}
            </div>
            
            {/* PDF Viewer - Keep width the same as when no chat */}
            <div 
              ref={containerRef}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              className="w-full lg:w-1/2 h-[70vh] overflow-auto border border-gray-300 rounded-lg shadow bg-white relative"
            >
              <Document
                file={fileUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={(err) => {
                  console.error("PDF load error:", err);
                  setError(`Failed to load PDF: ${err.message}`);
                }}
                loading={<div className="flex justify-center items-center h-full"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-700"></div><span className="ml-3">Loading PDF...</span></div>}
              >
                {numPages ? (
                  Array.from(new Array(numPages), (el, index) => (
                    <div key={`page_wrapper_${index + 1}`} className="pdf-page-wrapper relative mb-2 border-b last:border-b-0" data-page-number={index + 1}>
                      <Page
                        key={`page_${index + 1}`}
                        pageNumber={index + 1}
                        width={containerRef.current ? containerRef.current.clientWidth : undefined} // Use full container width
                        renderTextLayer={true} // Enable text layer for selection/accessibility
                        renderAnnotationLayer={true}
                      />
                      {/* Render analysis boxes only if analysis results exist */}
                      {analysisResult && analysisResult
                        .filter(box => box.page_number === index + 1)
                        .map((box, boxIndex) => {
                          // Calculate percentage positions with adjustments for accurate alignment
                          const leftPercent = (box.left / box.page_width) * 100;
                          const topPercent = (box.top / box.page_height) * 100;
                          const widthPercent = (box.width / box.page_width) * 100;
                          const heightPercent = (box.height / box.page_height) * 100;
                          
                          return (
                            <div
                              key={`box_${index + 1}_${boxIndex}`}
                              className="absolute border border-dashed"
                              style={{
                                left: `${leftPercent}%`,
                                top: `${topPercent}%`,
                                width: `${widthPercent}%`,
                                height: `${heightPercent}%`,
                                backgroundColor: getTypeColor(box.type),
                                borderColor: getTypeColor(box.type).replace('0.2', '0.5').replace('0.1', '0.4'), // Darker border
                                pointerEvents: 'none', // Let mouse events pass through to page
                              }}
                            />
                          );
                        })}
                    </div>
                  ))
                ) : (
                  <div className="flex justify-center items-center h-full">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-700"></div>
                    <span className="ml-3">Loading PDF...</span>
                  </div>
                )}
              </Document>
            </div>

            {/* Chat Interface - Position to the right, outside of normal document flow */}
            <div className="w-full lg:w-1/4 h-[50vh] bg-white p-4 rounded-lg shadow flex flex-col">
              {analysisResult && chatFileHash ? (
                <>
                  <h2 className="text-lg font-semibold mb-3 text-gray-800">Chat with Document</h2>
                  
                  {/* Chat History Display */}
                  <div className="flex-grow overflow-y-auto border border-gray-200 rounded p-3 mb-3 bg-gray-50">
                    {chatHistory.map((msg, index) => (
                      <div key={index} className={`mb-3 ${
                          msg.sender === 'user' ? 'text-right' : 'text-left'
                        }`}>
                        <span className={`inline-block p-2 rounded-lg max-w-full break-words ${
                            msg.sender === 'user' 
                            ? 'bg-blue-500 text-white' 
                            : 'bg-gray-200 text-gray-800'
                          }`}>
                          {msg.text}
                          {/* Sources for bot messages with toggle functionality */}
                          {msg.sender === 'bot' && msg.sources && msg.sources.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-gray-300 text-xs text-left">
                              <button 
                                onClick={(e) => {
                                  e.preventDefault(); // Prevent form submission
                                  if (msg.id) toggleSourceExpansion(msg.id);
                                }} 
                                className="font-semibold mb-1 text-blue-600 hover:text-blue-800 flex items-center"
                              >
                                Sources: ({msg.sources.length})
                                <svg 
                                  className={`ml-1 w-4 h-4 transition-transform duration-200 ${
                                    msg.id && expandedSources.has(msg.id) ? 'transform rotate-180' : ''
                                  }`} 
                                  fill="none" 
                                  stroke="currentColor" 
                                  viewBox="0 0 24 24" 
                                  xmlns="http://www.w3.org/2000/svg"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path>
                                </svg>
                              </button>
                              {msg.id && expandedSources.has(msg.id) && (
                                <ul>
                                  {msg.sources.map((source, s_idx) => (
                                    <li key={s_idx} title={JSON.stringify(source.metadata)} className="mb-1 p-1 bg-gray-100 rounded break-words overflow-hidden">
                                      [...{source.metadata.page_number ? `P${source.metadata.page_number}` : 'N/A'}] {source.content_preview}
                                    </li>
                                  ))}
                                </ul>
                              )}
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
                            <span className="inline-block p-2 rounded-lg bg-red-100 text-red-700 break-words">
                                Error: {chatError}
                            </span>
                        </div>
                    )}
                    {/* Dummy div to ensure scrolling to bottom */}
                    <div ref={chatEndRef} /> 
                  </div>

                  {/* Chat Input Form - Fixed at bottom */}
                  <form onSubmit={handleChatSubmit} className="flex items-center mt-auto">
                    <input
                      type="text"
                      value={chatQuery}
                      onChange={(e) => setChatQuery(e.target.value)}
                      placeholder="Ask a question..."
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
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center text-gray-500">
                  <svg className="w-12 h-12 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path>
                  </svg>
                  <p className="text-sm mb-2">Chat will appear here</p>
                  <p className="text-xs">Click "Analyze Document" to enable chat</p>
                </div>
              )}
            </div>
          </div>
        ) : !isLoading && (
          <p className="text-gray-500">Upload a PDF to view it here.</p>
        )}
      </div>
    </main>
  );
}
