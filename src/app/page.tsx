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

// localStorage keys
const LS_RESULT_PREFIX = 'speakeasy_analysis_result_';
const LS_NUMPAGES_PREFIX = 'speakeasy_num_pages_'; // Removed as numPages is no longer cached

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null); // Store filename for caching key
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [analysisResult, setAnalysisResult] = useState<SegmentBox[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [usingCachedResult, setUsingCachedResult] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null); // Ref for the container div
  const [hoveredBox, setHoveredBox] = useState<SegmentBox | null>(null); // Store the box object

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

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      const selectedFile = event.target.files[0];
      const currentFileName = selectedFile.name;

      // Clear previous state
      setFile(selectedFile);
      setFileName(currentFileName);
      setAnalysisResult(null);
      setError(null);
      setNumPages(null);
      setUsingCachedResult(false);
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl);
      }
      const newFileUrl = URL.createObjectURL(selectedFile);
      setFileUrl(newFileUrl);

      // Check localStorage for cached results
      const resultCacheKey = `${LS_RESULT_PREFIX}${currentFileName}`;
      console.log(`Checking cache with key: ${resultCacheKey}`); // Log retrieval key

      const cachedResultStr = localStorage.getItem(resultCacheKey);

      // Load from cache if ONLY the result string is found
      if (cachedResultStr) { 
        console.log(`Found cached result for ${currentFileName}`);
        try {
          const cachedResult: SegmentBox[] = JSON.parse(cachedResultStr);
          setAnalysisResult(cachedResult);
          setUsingCachedResult(true);
        } catch (e) {
          console.error("Failed to parse cached results:", e);
          // Clear potentially corrupted cache
          localStorage.removeItem(resultCacheKey);
        }
      } else {
        console.log(`No cached results found for ${currentFileName}`);
      }
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
    // Keep existing analysisResult if using cache, otherwise clear it
    if (!usingCachedResult) {
        setAnalysisResult(null);
    }
    // Keep numPages if using cache, it will be set by react-pdf later if not
    setUsingCachedResult(false); // Reset cache flag on new analysis attempt

    const formData = new FormData();
    formData.append('file', file);

    try {
      console.log(`Starting analysis for ${fileName}...`);
      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result: SegmentBox[] = await response.json();
      setAnalysisResult(result);
      console.log(`Analysis successful for ${fileName}. Saving results to localStorage.`);

      // Save successful result to localStorage
      // Note: numPages will be set by onDocumentLoadSuccess after rendering
      // We need to save it there or refetch it if needed.
      // Let's save the result here, and handle numPages saving in onDocumentLoadSuccess
      const resultSaveKey = `${LS_RESULT_PREFIX}${fileName}`;
      console.log(`Attempting to save result to cache with key: ${resultSaveKey}`); // Log save key
      localStorage.setItem(resultSaveKey, JSON.stringify(result));

    } catch (err) {
      console.error("Analysis error:", err);
      setError(err instanceof Error ? err.message : "An unknown error occurred during analysis.");
      setFileUrl(null); // Clear file URL on analysis error
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      setAnalysisResult(null); // Clear results on error
      setNumPages(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Callback for react-pdf Document load success
  function onDocumentLoadSuccess({ numPages: nextNumPages }: { numPages: number }): void {
    setNumPages(nextNumPages);
    // If analysis results exist and we have a filename, save numPages to cache
    // Remove saving logic - numPages is determined by react-pdf on load
    
    if (analysisResult && fileName && !usingCachedResult) { // Only save if it was a fresh analysis
        const numPagesSaveKey = `${LS_NUMPAGES_PREFIX}${fileName}`;
        console.log(`Attempting to save numPages (${nextNumPages}) to cache with key: ${numPagesSaveKey}`); // Log save key
        localStorage.setItem(numPagesSaveKey, JSON.stringify(nextNumPages));
    }
    
  }

  // Function to clear cache for the current file
  const clearCache = () => {
    if (fileName) {
        console.log(`Clearing cache for ${fileName}`);
        const resultCacheKey = `${LS_RESULT_PREFIX}${fileName}`;
        localStorage.removeItem(resultCacheKey);
        // Reset state to reflect cleared cache
        setAnalysisResult(null);
        setNumPages(null);
        setUsingCachedResult(false);
        // Optionally re-select the file or prompt user
    } else {
        alert("No file selected to clear cache for.");
    }
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
              {isLoading ? 'Analyzing...' : (usingCachedResult ? 'Re-Analyze PDF' : 'Analyze PDF')}
            </button>
            {file && (
              <button
                type="button"
                onClick={clearCache}
                title="Clear cached analysis results for this file"
                className="px-4 py-2 bg-red-100 text-red-700 rounded-md hover:bg-red-200 text-sm transition duration-150 ease-in-out"
              >
                Clear Cache
              </button>
            )}
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
              {usingCachedResult && <span className="text-sm text-green-600 font-medium">(Using Cached Results)</span>}
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

      </main>

      <footer className="mt-12 text-center text-gray-500 text-sm">
        Powered by Next.js and Huridocs
      </footer>
    </div>
  );
}
