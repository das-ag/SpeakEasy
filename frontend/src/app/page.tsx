"use client";

import { useState, ChangeEvent, FormEvent, useEffect, useRef, MouseEvent } from 'react';
// Import react-pdf components and configure worker
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  bbox?: number[]; // Added bbox property
}

// Interface for chat messages
interface ChatMessage {
  sender: 'user' | 'bot';
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sources?: any[]; // Optional: To store source document snippets
  id?: string; // Add unique identifier for tracking expanded state
}

// New interface for document summaries
interface DocumentSummary {
  summary: string;
  text: string;
  page: number;
  bbox: number[];
}

// New interface for summary response
interface SummaryResponse {
  summaries: Record<string, DocumentSummary>;
  is_partial: boolean;
  count: number;
  status: 'in_progress' | 'complete' | 'failed';
  error?: string;
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
  const [clickedBox, setClickedBox] = useState<SegmentBox | null>(null);
  const [showToast, setShowToast] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string>("");
  const [isReading, setIsReading] = useState<boolean>(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [showVoiceSelector, setShowVoiceSelector] = useState<boolean>(false);
  const [speechRate, setSpeechRate] = useState<number>(1.0);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null); // To hold the SpeechRecognition instance
  const [lastQueryWasVoice, setLastQueryWasVoice] = useState<boolean>(false);

  // --- Chat State ---
  const [chatFileHash, setChatFileHash] = useState<string | null>(null);
  const [chatQuery, setChatQuery] = useState<string>("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null); // Ref to scroll chat to bottom
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set()); // Track expanded sources

  // New state variables for summaries
  const [summaries, setSummaries] = useState<Record<string, DocumentSummary> | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState<boolean>(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [showSummaries, setShowSummaries] = useState<boolean>(false);
  
  // New state variable for document statistics section
  const [showStatistics, setShowStatistics] = useState<boolean>(false);

  // New state variable to track highlighted summary block
  const [highlightedSummaryId, setHighlightedSummaryId] = useState<string | null>(null);

  // Add a new state variable for summary search
  const [summarySearchQuery, setSummarySearchQuery] = useState<string>("");

  // New state variable for total segments estimate
  const [totalSegmentsEstimate, setTotalSegmentsEstimate] = useState<number>(0);

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

  // Load available voices when the component mounts
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      // Function to populate voices
      const populateVoices = () => {
        const voices = window.speechSynthesis.getVoices();
        console.log('Available voices:', voices);
        setAvailableVoices(voices);
        
        // Set default voice - prefer Google US, then system default, then first available
        if (voices.length > 0) {
          // Look for Google US voice
          const googleUSVoice = voices.find(voice => 
            voice.name.includes('Google') && 
            (voice.name.includes('US') || voice.lang === 'en-US')
          );
          
          // Fall back to any Google voice
          const anyGoogleVoice = googleUSVoice || voices.find(voice => voice.name.includes('Google'));
          
          // Fall back to system default or first voice if Google voices not found
          const defaultVoice = anyGoogleVoice || voices.find(voice => voice.default) || voices[0];
          setSelectedVoice(defaultVoice);
          console.log('Default voice set to:', defaultVoice.name);
        }
      };
      
      // Get voices - may be async in some browsers
      populateVoices();
      
      // Chrome requires this event to get voices
      window.speechSynthesis.onvoiceschanged = populateVoices;
      
      return () => {
        // Cleanup
        window.speechSynthesis.onvoiceschanged = null;
      };
    }
  }, []);

  // Initialize SpeechRecognition
  useEffect(() => {
    console.log("Attempting to initialize SpeechRecognition...");
    if (typeof window !== 'undefined') {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      console.log("SpeechRecognition API found:", SpeechRecognition ? "Yes" : "No");
      
      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          console.log("Created recognition instance:", recognition);
          
          recognition.continuous = false; // Listen for a single utterance
          recognition.interimResults = false; // Only get final results
          recognition.lang = 'en-US'; // Set language

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          recognition.onresult = (event: { results: { transcript: any; }[][]; }) => {
            const transcript = event.results[0][0].transcript;
            console.log('Speech recognized:', transcript);
            setChatQuery(transcript); // Update input box with recognized text
            setIsRecording(false); // Stop recording state
          };

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          recognition.onerror = (event: { error: any; }) => {
            console.error('Speech recognition error:', event.error);
            setError(`Speech recognition error: ${event.error}`);
            setIsRecording(false);
          };

          recognition.onend = () => {
            console.log('Speech recognition ended.');
            setIsRecording(false); // Ensure recording state is off
          };

          recognitionRef.current = recognition;
          console.log('Speech recognition initialized successfully. recognitionRef.current:', recognitionRef.current);
        } catch (err) {
          console.error("Error creating SpeechRecognition instance:", err);
        }
      } else {
        console.warn('Speech recognition not supported by this browser.');
      }
    } else {
      console.log("Window object not found, skipping SpeechRecognition init.");
    }
  }, []);

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
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
        // Don't clear hoveredBox anymore - we want it to persist
        // if (hoveredBox !== null) {
        //     setHoveredBox(null); // Clear hover if mouse moved out of all pages
        // }
        return;
    }

    // --- Start: Calculations based on hovered page ---
    const currentPageElement = container.querySelector<HTMLDivElement>(`.pdf-page-wrapper[data-page-number="${hoveredPageNumber}"]`);
    // Find the canvas within the page wrapper
    const canvasElement = currentPageElement?.querySelector('canvas');

    if (!currentPageElement || !canvasElement || canvasElement.offsetWidth <= 0 || canvasElement.offsetHeight <= 0) {
        console.error("Could not find valid page element or canvas for hover calculation.");
        // Don't clear hoveredBox anymore - we want it to persist
        // if (hoveredBox !== null) setHoveredBox(null); // Clear hover if calculation fails
        return;
    }

    const renderedWidth = canvasElement.offsetWidth; // Use canvas width
    const renderedHeight = canvasElement.offsetHeight;
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

    // Only update state if we found a box (don't clear hoveredBox if we didn't find one)
    if (foundBox !== null) {
        setHoveredBox(foundBox);
    }
  };

  // Function to handle mouse click on the PDF container
  const handleContainerClick = (e: React.MouseEvent) => {
    // Only handle clicks directly on the container (not on boxes)
    if (e.target === e.currentTarget) {
      setClickedBox(null);
      setHighlightedSummaryId(null);
    }
  };

  // Modified to not clear hoveredBox when mouse leaves container
  const handleMouseLeave = () => {
    // Don't clear hoveredBox anymore - we want it to persist
    // setHoveredBox(null);
  };

  // Reusable function to send a chat message and handle the response
  const sendChatMessage = async (queryText: string) => {
    if (!queryText.trim() || !chatFileHash || isChatLoading) {
      return; // Don't submit empty queries or while loading/no hash
    }

    const userMessage: ChatMessage = { 
      sender: 'user', 
      text: queryText,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` 
    };
    setChatHistory(prev => [...prev, userMessage]);
    setChatQuery(""); // Clear input box after sending
    setIsChatLoading(true);
    setChatError(null);

    try {
        console.log(`Sending chat query for hash ${chatFileHash.substring(0,8)}...: ${queryText}`);
        const chatApiUrl = `/api/chat/${chatFileHash}`;

        const response = await fetch(chatApiUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ query: queryText }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorMsg = `Chat API error! status: ${response.status}`;
            try { 
              const errorData = JSON.parse(errorText); 
              errorMsg = errorData.error || errorMsg; 
            } 
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            catch (parseError) { errorMsg = errorText || errorMsg; }
            throw new Error(errorMsg);
        }

        const result = await response.json();
        console.log("Chat API response received:", result);

        const botMessage: ChatMessage = {
            sender: 'bot',
            text: result.response,
            sources: result.sources,
            id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        };
        setChatHistory(prev => [...prev, botMessage]);

        // Auto-read response if the query was made by voice
        if (lastQueryWasVoice) {
          console.log("Last query was voice, attempting to read bot response.");
          handleChatMessageClick(botMessage); // Read the new bot message
          setLastQueryWasVoice(false); // Reset the flag
        }

    } catch (err) {
        console.error("Chat error:", err);
        const errorText = err instanceof Error ? err.message : "An unknown error occurred during chat.";
        setChatError(errorText);
        setChatHistory(prev => [...prev, {
          sender: 'bot', 
          text: `Error: ${errorText}`,
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        }]);
    } finally {
        setIsChatLoading(false);
        // Ensure voice flag is reset even if auto-read didn't trigger or failed
        if (lastQueryWasVoice) {
            setLastQueryWasVoice(false);
        } 
    }
  };

  // Original form submission handler - now just calls sendChatMessage
  const handleChatSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLastQueryWasVoice(false); // Ensure flag is false for manual submission
    sendChatMessage(chatQuery);
  };

  // Function to start speech recognition
  const startRecording = () => {
    if (recognitionRef.current && !isRecording) {
      try {
        // Stop any ongoing speech first
        stopReading();
        
        setLastQueryWasVoice(true); // Set flag for voice input
        recognitionRef.current.start();
        setIsRecording(true);
        console.log('Speech recognition started.');
      } catch (error) {
        console.error('Error starting speech recognition:', error);
        setError('Could not start voice recognition.');
        setLastQueryWasVoice(false); // Reset flag on error
      }
    }
  };

  // Function to stop speech recognition (usually automatic, but can be manual)
  const stopRecordingManually = () => {
    if (recognitionRef.current && isRecording) {
      recognitionRef.current.stop();
      // onend handler will set isRecording to false
      console.log('Speech recognition stopped manually.');
    }
  };

  // Function to toggle voice selector
  const toggleVoiceSelector = () => {
    setShowVoiceSelector(prev => !prev);
  };

  // Function to handle click on a bounding box
  const handleBoxClick = (box: SegmentBox, event: React.MouseEvent) => {
    // Stop event propagation to prevent interference
    event.stopPropagation();
    
    console.log("Box clicked:", box);
    
    // Only proceed if there's text to read
    if (!box.text || box.text.trim() === "") {
      return;
    }
    
    // Set as clicked for visual feedback
    setClickedBox(box);
    
    // Simple text-to-speech implementation
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        // Cancel any ongoing speech
        window.speechSynthesis.cancel();
        
        // Create and speak the utterance
        const utterance = new SpeechSynthesisUtterance(box.text);
        
        // Apply selected voice if available
        if (selectedVoice) {
          utterance.voice = selectedVoice;
          console.log('Using voice:', selectedVoice.name);
        }
        
        // Apply speech rate
        utterance.rate = speechRate;
        console.log('Using speech rate:', speechRate);
        
        // Set reading state to true
        setIsReading(true);
        setToastMessage(`Reading: ${box.type}`);
        setShowToast(true);
        
        // Add event handlers for speech lifecycle
        utterance.onstart = () => {
          console.log('Speech started');
          // Ensure reading state is set
          setIsReading(true);
          setShowToast(true);
        };
        
        utterance.onend = () => {
          console.log('Speech ended');
          // Reset states when speech completes
          setClickedBox(null);
          setIsReading(false);
          setShowToast(false);
        };
        
        utterance.onerror = () => {
          console.error('Speech error');
          // Reset states on error
          setClickedBox(null);
          setIsReading(false);
          setShowToast(false);
        };
        
        // Add a periodic check to ensure indicator stays visible during long speeches
        const checkInterval = setInterval(() => {
          if (window.speechSynthesis.speaking) {
            setIsReading(true);
          } else {
            clearInterval(checkInterval);
          }
        }, 100);
        
        // Speak the text
        window.speechSynthesis.speak(utterance);
      } else {
        console.error("Speech synthesis not available in this browser");
      }
    } catch (error) {
      console.error("Error in speech synthesis:", error);
      setIsReading(false);
      setShowToast(false);
    }
  };

  // Function to handle click on a chat message (works for user and bot)
  const handleChatMessageClick = (message: ChatMessage) => {
    // Only read messages with text
    if (!message.text || message.text.trim() === "") {
      return;
    }
    
    console.log("Chat message clicked:", message.text.substring(0, 50) + '...');
    
    // Use existing TTS logic
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        // Cancel any ongoing speech
        window.speechSynthesis.cancel();
        
        // Create and speak the utterance
        const utterance = new SpeechSynthesisUtterance(message.text);
        
        // Apply selected voice and rate
        if (selectedVoice) utterance.voice = selectedVoice;
        utterance.rate = speechRate;
        
        // Set reading state and indicator message
        setIsReading(true);
        // Show beginning of message in toast
        setToastMessage(`Reading: "${message.text.substring(0, 40)}${message.text.length > 40 ? '...' : ''}"`); 
        setShowToast(true);
        
        // Add event handlers for speech lifecycle
        utterance.onstart = () => {
          console.log('Chat Speech started');
          setIsReading(true);
          setShowToast(true);
        };
        
        utterance.onend = () => {
          console.log('Chat Speech ended');
          setIsReading(false);
          setShowToast(false);
          // We don't need to reset clickedBox here
        };
        
        utterance.onerror = (event) => {
          // Log the specific speech error event
          console.error('Chat Speech error:', event);
          setIsReading(false);
          setShowToast(false);
        };
        
        // Speak the text
        window.speechSynthesis.speak(utterance);
      } else {
        console.error("Speech synthesis not available");
      }
    } catch (error) {
      console.error("Error in chat speech synthesis:", error);
      setIsReading(false);
      setShowToast(false);
    }
  };

  // Update SpeechRecognition onresult to call sendChatMessage
  useEffect(() => {
    // ... existing initialization ...
    if (recognitionRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        console.log('Speech recognized:', transcript);
        // Don't update chatQuery here, directly send the message
        // setChatQuery(transcript);
        setIsRecording(false); // Stop recording state
        sendChatMessage(transcript); // Auto-send the message
      };
    }
    // ... rest of useEffect ...
  }, [chatFileHash, isChatLoading, lastQueryWasVoice, selectedVoice, speechRate]); // Add dependencies

  // Function to stop any active text-to-speech
  const stopReading = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      // Reset state related to reading
      setIsReading(false);
      setClickedBox(null); 
      setShowToast(false); 
    }
  };

  // Update fetchSummaries to handle partial results and auto-refresh
  const fetchSummaries = async (getPartial: boolean = false, resume: boolean = false) => {
    if (!chatFileHash) {
      setSummaryError("No document available for summarization.");
      return;
    }
    
    // Only set loading state initially, not during refreshes
    if (!getPartial || !summaries) {
      setIsSummaryLoading(true);
    }
    
    try {
      const url = `/api/summarize/${chatFileHash}${getPartial ? '?partial=true' : ''}${resume ? (getPartial ? '&' : '?') + 'resume=true' : ''}`;
      console.log(`Fetching summaries for document with hash ${chatFileHash.substring(0,8)}...${getPartial ? ' (partial)' : ''}${resume ? ' (resuming generation)' : ''}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to fetch summaries: ${response.status}`);
      }
      
      const result: SummaryResponse = await response.json();
      console.log("Summaries fetched:", result);
      
      if (result.summaries) {
        // Count the number of summaries we've received
        const summaryCount = Object.keys(result.summaries).length;
        
        // Always update summaries with the latest data
        setSummaries(result.summaries);
        
        // Always update the count message if we have summaries
        const statusMessage = result.is_partial 
          ? `Loading summaries: ${summaryCount} segments processed so far...` 
          : `Completed: ${summaryCount} segments processed.`;
        
        // Update the UI with the status message
        setSummaryError(result.is_partial ? statusMessage : null);
        console.log(statusMessage);
        
        // Don't automatically show summaries when generated
        // setShowSummaries(true);
        
        // If it's a partial result, schedule a refresh
        if (result.is_partial && result.status === 'in_progress') {
          // Schedule refresh in 5 seconds
          setTimeout(() => {
            if (document.hasFocus()) { // Only refresh if the page is still in focus
              fetchSummaries(true);
            }
          }, 5000);
        } else if (result.status === 'failed') {
          setSummaryError(`Generation incomplete: ${result.error || 'Unknown error'}`);
        }
      } else {
        throw new Error("No summaries returned from the server");
      }
    } catch (error) {
      console.error("Error fetching summaries:", error);
      setSummaryError(error instanceof Error ? error.message : "Unknown error fetching summaries");
    } finally {
      if (!getPartial) {
        setIsSummaryLoading(false);
      }
    }
  };

  // Add this function to get initial partial results quickly and resume generation
  const startSummaryGeneration = async () => {
    // Estimate total segments from the analysis result
    if (analysisResult) {
      // Count text elements in the analysis result
      const textElements = analysisResult.filter(box => 
        box.text && box.text.trim().length > 10
      );
      const estimate = Math.max(340, textElements.length); // Use 340 as minimum (from backend logs)
      setTotalSegmentsEstimate(estimate);
      console.log(`Estimated ${estimate} total segments for summarization`);
    }
    
    // First check for partial results
    await fetchSummaries(true);
    // Then request full generation with resume=true to continue from where it left off
    await fetchSummaries(false, true);
  };

  // Update the progress bar to use the estimated total segments
  const getProgressPercentage = () => {
    if (!summaries) return 0;
    const count = Object.keys(summaries).length;
    const total = totalSegmentsEstimate > 0 ? totalSegmentsEstimate : 340; // Fallback to 340 if no estimate
    return Math.min(100, (count / total) * 100);
  };

  // Function to handle clicking on a summary
  const handleSummaryClick = (id: string, summary: DocumentSummary) => {
    // Find the corresponding box in the analysis result based on the page and bbox
    if (analysisResult) {
      const matchingBox = analysisResult.find(box => 
        box.page_number === summary.page && 
        JSON.stringify(box.bbox) === JSON.stringify(summary.bbox)
      );
      
      if (matchingBox) {
        // Set the clicked box to highlight it on the PDF
        setClickedBox(matchingBox);
        
        // Highlight just this summary
        setHighlightedSummaryId(id);
        
        // Scroll to the relevant page if possible
        const pageElement = document.querySelector(`[data-page-number="${summary.page}"]`);
        if (pageElement && containerRef.current) {
          containerRef.current.scrollTo({
            top: pageElement.getBoundingClientRect().top + containerRef.current.scrollTop - 100,
            behavior: 'smooth'
          });
        }

        // Read the summary aloud
        try {
          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            // Cancel any ongoing speech
            window.speechSynthesis.cancel();
            
            // Create and speak the utterance
            const utterance = new SpeechSynthesisUtterance(summary.summary);
            
            // Apply selected voice if available
            if (selectedVoice) {
              utterance.voice = selectedVoice;
              console.log('Using voice:', selectedVoice.name);
            }
            
            // Apply speech rate
            utterance.rate = speechRate;
            console.log('Using speech rate:', speechRate);
            
            // Set reading state to true
            setIsReading(true);
            setToastMessage(`Reading Summary: ${summary.summary.substring(0, 40)}${summary.summary.length > 40 ? '...' : ''}`);
            setShowToast(true);
            
            // Add event handlers for speech lifecycle
            utterance.onstart = () => {
              console.log('Speech started');
              // Ensure reading state is set
              setIsReading(true);
              setShowToast(true);
            };
            
            utterance.onend = () => {
              console.log('Speech ended');
              // Reset states when speech completes
              setIsReading(false);
              setShowToast(false);
              // Don't clear the clickedBox or highlightedSummaryId to maintain visual highlight
            };
            
            utterance.onerror = () => {
              console.error('Speech error');
              // Reset states on error
              setIsReading(false);
              setShowToast(false);
            };
            
            // Speak the text
            window.speechSynthesis.speak(utterance);
          } else {
            console.error("Speech synthesis not available in this browser");
          }
        } catch (error) {
          console.error("Error in speech synthesis:", error);
          setIsReading(false);
          setShowToast(false);
        }
      }
    }
  };

  // Function to toggle the expansion of sources for a message
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

  // Find or create a function to get summary for a specific element
  const findSummaryForElement = (box: SegmentBox | null): DocumentSummary | null => {
    if (!box || !summaries) return null;
    
    // Try to find a matching summary based on page number and bbox
    return Object.entries(summaries).reduce((match, [, summary]) => {
      if (match) return match;
      
      // Check if this summary matches the box (same page and similar position)
      if (summary.page === box.page_number && 
          box.bbox && summary.bbox && 
          JSON.stringify(box.bbox) === JSON.stringify(summary.bbox)) {
        return summary;
      }
      
      // Alternative matching if bbox isn't matching precisely
      // Check if this summary text matches or contains the box text
      if (summary.page === box.page_number && 
          (summary.text === box.text || 
           summary.text.includes(box.text) || 
           box.text.includes(summary.text))) {
        return summary;
      }
      
      return null;
    }, null as DocumentSummary | null);
  };

  return (
    <main className="flex min-h-screen flex-col p-4 md:p-8 lg:p-12 bg-gray-50">
      {/* Reading Indicator - Made clickable to stop reading */}
      {isReading && (
        <div className="fixed top-4 right-4 z-50">
          <div 
            className="bg-red-600 text-white px-4 py-2 rounded shadow-lg flex items-center cursor-pointer hover:bg-red-700 transition-colors duration-200 select-none"
            onClick={stopReading}
            title="Click to stop reading"
          >
            <span className="animate-pulse mr-2">●</span>
            {toastMessage}
            <svg 
              className="ml-2 w-4 h-4" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24" 
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="6" y="6" width="12" height="12" strokeWidth="2" />
            </svg>
          </div>
        </div>
      )}
      
      {/* Toast Notification (keep for other notifications) */}
      {showToast && !isReading && (
        <div className="fixed top-4 right-4 bg-blue-600 text-white px-4 py-2 rounded shadow-lg z-50 max-w-md">
          {toastMessage}
        </div>
      )}
      
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
            <label htmlFor="pdfUpload" className="block text-gray-700 text-sm font-bold mb-2">
              Upload PDF Document:
            </label>
            <div className="flex flex-col">
              <div className="flex items-center">
                <label 
                  className="w-full flex items-center justify-center bg-blue-100 hover:bg-blue-200 text-blue-700 font-semibold py-2 px-4 rounded border border-blue-300 cursor-pointer transition-colors duration-200"
                >
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                  </svg>
                  {fileName ? 'Change File' : 'Choose PDF File'}
                  <input
                    id="pdfUpload"
                    type="file"
                    onChange={handleFileChange}
                    className="hidden"
                    accept="application/pdf"
                    disabled={isLoading}
                  />
                </label>
              </div>
              {fileName && (
                <div className="mt-2 text-sm text-gray-700 font-medium flex items-center">
                  <svg className="w-4 h-4 mr-1 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"></path>
                  </svg>
                  {fileName}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center">
            <button
              type="submit"
              disabled={!fileName || isLoading}
              className={`bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline ${
                !fileName || isLoading ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Analyze Document
            </button>
            
            {/* Inline loading indicator */}
            {isLoading && (
              <div className="flex items-center ml-4">
                <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-blue-500 mr-2"></div>
                <span className="text-sm text-gray-700">Analyzing...</span>
              </div>
            )}
          </div>
          {error && <p className="text-red-500 text-xs italic mt-4">Error: {error}</p>}
        </form>

        {/* --- PDF Viewer and Chat Container */}
        {fileUrl ? (
          <div className="w-full flex flex-col lg:flex-row gap-6">
            {/* Metadata Panel - Slightly reduce width */}
            <div className="w-full lg:w-1/6 h-[70vh] bg-white p-4 rounded-lg shadow-md border border-gray-200 flex flex-col overflow-auto">
              {/* Document Elements section with proper header hierarchy */}
              <div className="section mb-6">
                <h2 className="text-lg font-bold text-gray-900 mb-4">Document Elements</h2>
                
                {chatFileHash && (
                  <div>
                    <button
                      onClick={startSummaryGeneration}
                      disabled={isSummaryLoading}
                      className={`px-3 py-1.5 rounded text-white font-medium text-sm flex items-center ${
                        isSummaryLoading ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
                      }`}
                    >
                      {isSummaryLoading ? (
                        <>
                          <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Generating...
                        </>
                      ) : summaries && Object.keys(summaries).length > 0 ? (
                        "Refresh Summaries"
                      ) : (
                        "Generate Summaries"
                      )}
                    </button>
                    
                    {summaryError && (
                      <div className="mt-2">
                        {summaryError.startsWith('Loading summaries:') ? (
                          <div className="text-blue-700 text-sm flex flex-col">
                            <div className="flex items-center">
                              {summaryError}
                            </div>
                            {summaries && (
                              <div className="mt-1 w-full bg-gray-200 rounded-full h-1.5">
                                <div 
                                  className="bg-blue-600 h-1.5 rounded-full transition-all duration-500 ease-out" 
                                  style={{ 
                                    width: `${getProgressPercentage()}%` 
                                  }}
                                ></div>
                              </div>
                            )}
                            <div className="text-xs text-gray-600 mt-0.5">
                              {Object.keys(summaries || {}).length} of ~{totalSegmentsEstimate || 340} segments
                            </div>
                          </div>
                        ) : (
                          // Only show actual errors, not loading states
                          !summaryError.includes("Loading") && !summaryError.includes("loading") ? (
                            <div className="text-red-500 text-sm">{summaryError}</div>
                          ) : null
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              
              {/* Add a toggle for showing all summaries */}
              {summaries && Object.keys(summaries).length > 0 && (
                <div className="mt-2 mb-3 flex justify-end">
                  <button
                    onClick={() => setShowSummaries(!showSummaries)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    {showSummaries ? 'Hide All Summaries' : 'Show All Summaries'}
                  </button>
                </div>
              )}
              
              {isLoading ? (
                /* Loading state for Document Elements */
                <div className="flex-grow flex flex-col items-center justify-center text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mb-3"></div>
                  <p className="text-gray-700 font-medium mb-1">Analyzing document...</p>
                  <p className="text-sm text-gray-500">Element details will appear here when analysis is complete.</p>
                </div>
              ) : (
                /* Normal content when not loading */
                <>
                  {/* Summaries Section - Show if available and requested */}
                  {showSummaries && summaries && (
                    <div className="mb-4 border-b border-gray-300 pb-3">
                      <div className="flex justify-between items-center mb-2">
                        <h3 className="font-medium text-gray-900">Document Summaries</h3>
                        {summaryError && !summaryError.startsWith("Loading") && (
                          <span className="text-xs text-red-600">{summaryError}</span>
                        )}
                      </div>
                      
                      {/* Progress indicator for loading */}
                      {summaryError && summaryError.startsWith("Loading") && (
                        <div className="flex items-center mb-2 bg-blue-50 p-2 rounded">
                          <div className="animate-pulse h-2 w-2 bg-blue-500 rounded-full mr-2"></div>
                          <span className="text-xs text-blue-700">{summaryError}</span>
                        </div>
                      )}
                      
                      {/* Add search input for summaries */}
                      <div className="mb-2">
                        <input
                          type="text"
                          value={summarySearchQuery}
                          onChange={(e) => setSummarySearchQuery(e.target.value)}
                          placeholder="Search summaries..."
                          className="w-full p-1 text-sm border border-gray-300 rounded"
                        />
                      </div>
                      
                      <div className="max-h-[200px] overflow-y-auto pr-1">
                        {/* Filter summaries based on search query */}
                        {summaries && Object.entries(summaries).length > 0 ? (
                          Object.entries(summaries)
                            .filter(([, summary]) => 
                              summarySearchQuery === "" || 
                              summary.summary.toLowerCase().includes(summarySearchQuery.toLowerCase()) ||
                              summary.text.toLowerCase().includes(summarySearchQuery.toLowerCase())
                            )
                            .map(([id, summary]) => (
                              <div 
                                key={id} 
                                className={`mb-2 p-2 rounded cursor-pointer transition-colors ${
                                  highlightedSummaryId === id 
                                    ? 'bg-blue-200 border-2 border-orange-500 shadow-md' 
                                    : 'bg-blue-50 border border-blue-100 hover:bg-blue-100'
                                }`}
                                onClick={() => handleSummaryClick(id, summary)}
                              >
                                <div className="text-xs text-gray-500 mb-1">
                                  Page {summary.page} | ID: {id.substring(0, 6)}...
                                </div>
                                <div className="text-sm text-gray-800 mb-1">
                                  {summary.summary}
                                </div>
                                <div className="text-xs text-gray-600 italic truncate">
                                  Original: {summary.text.substring(0, 50)}...
                                </div>
                              </div>
                            ))
                        ) : (
                          <p className="text-sm text-gray-600 italic">No summaries available for this document.</p>
                        )}
                      </div>
                      <div className="flex justify-between mt-2">
                        <button
                          onClick={() => setShowSummaries(false)}
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          Hide Summaries
                        </button>
                        {summaries && Object.keys(summaries).length > 0 && (
                          <span className="text-xs text-gray-500">
                            {Object.keys(summaries).length} summaries
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  
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
                        
                        {/* Display summary if available */}
                        {summaries && (
                          <div className="mt-2">
                            <span className="font-semibold text-sm text-gray-900">Summary:</span>
                            {(() => {
                              const summary = findSummaryForElement(hoveredBox);
                              if (summary) {
                                return (
                                  <p 
                                    className={`text-xs mt-1 p-2 rounded whitespace-pre-wrap border transition-all duration-200 cursor-pointer ${
                                      isReading 
                                      ? 'bg-blue-100 border-2 border-orange-500 shadow-md' 
                                      : 'bg-blue-50 border border-blue-100 hover:bg-blue-100'
                                    } text-gray-800`}
                                    onClick={() => {
                                      // Stop any current audio
                                      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                                        window.speechSynthesis.cancel();
                                      }
                                      
                                      // Read the summary aloud
                                      try {
                                        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                                          const utterance = new SpeechSynthesisUtterance(summary.summary);
                                          
                                          // Apply selected voice if available
                                          if (selectedVoice) {
                                            utterance.voice = selectedVoice;
                                          }
                                          
                                          // Apply speech rate
                                          utterance.rate = speechRate;
                                          
                                          // Set reading state to true
                                          setIsReading(true);
                                          setToastMessage(`Reading summary: ${summary.summary.substring(0, 40)}${summary.summary.length > 40 ? '...' : ''}`);
                                          setShowToast(true);
                                          
                                          // Add event handlers for speech lifecycle
                                          utterance.onstart = () => {
                                            console.log('Summary speech started');
                                            setIsReading(true);
                                            setShowToast(true);
                                          };
                                          
                                          utterance.onend = () => {
                                            console.log('Summary speech ended');
                                            setIsReading(false);
                                            setShowToast(false);
                                          };
                                          
                                          utterance.onerror = () => {
                                            console.error('Speech error');
                                            setIsReading(false);
                                            setShowToast(false);
                                          };
                                          
                                          // Speak the text
                                          window.speechSynthesis.speak(utterance);
                                        }
                                      } catch (error) {
                                        console.error("Error in speech synthesis:", error);
                                        setIsReading(false);
                                        setShowToast(false);
                                      }
                                    }}
                                    title="Click to read summary aloud"
                                  >
                                    {summary.summary}
                                  </p>
                                );
                              } else {
                                return (
                                  <p className="text-xs mt-1 italic text-gray-500">
                                    {isSummaryLoading ? "Loading summaries..." : "No summary available"}
                                  </p>
                                );
                              }
                            })()}
                          </div>
                        )}
                        
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
                    <div className="border-t border-gray-200 pt-3 mt-3">
                      <div 
                        className="flex justify-between items-center cursor-pointer" 
                        onClick={() => setShowStatistics(!showStatistics)}
                      >
                        <h3 className="font-medium text-gray-900">Document Statistics</h3>
                        <button className="text-gray-500 focus:outline-none">
                          <svg 
                            className={`w-4 h-4 transition-transform ${showStatistics ? 'rotate-180' : ''}`} 
                            fill="none" 
                            stroke="currentColor" 
                            viewBox="0 0 24 24" 
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"></path>
                          </svg>
                        </button>
                      </div>
                      
                      {showStatistics && (
                        <ul className="text-sm space-y-2 text-gray-800 mt-2">
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
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            
            {/* PDF Viewer - Keep width the same as when no chat */}
            <div 
              ref={containerRef}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              onClick={handleContainerClick}
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
                          
                          // Determine if this is the currently hovered or highlighted box
                          const isHovered = hoveredBox === box;
                          const isClicked = clickedBox === box;
                          
                          // Add a small buffer (0.4%) to the hovered box to prevent border from overlapping text
                          const bufferAmount = (isHovered || isClicked) ? 0.4 : 0;
                          
                          return (
                            <div
                              key={`box_${index + 1}_${boxIndex}`}
                              className={`absolute border cursor-pointer ${
                                isHovered && isClicked ? 'border-2 z-30' : 
                                isHovered ? 'border-2 z-20' : 
                                isClicked ? 'border-dashed z-20' : 
                                'border-dashed z-10'
                              }`}
                              style={{
                                left: `${leftPercent - bufferAmount}%`,
                                top: `${topPercent - bufferAmount}%`,
                                width: `${widthPercent + (bufferAmount * 2)}%`,
                                height: `${heightPercent + (bufferAmount * 2)}%`,
                                backgroundColor: getTypeColor(box.type),
                                borderColor: isHovered && isClicked ? '#9C27B0' : // Purple for both hovered and clicked 
                                  isHovered ? '#FF5733' : // Orange for hovered
                                  isClicked ? '#2196F3' : // Blue for clicked
                                  getTypeColor(box.type).replace('0.2', '0.5').replace('0.1', '0.4'),
                                pointerEvents: 'auto', // Ensure clicks are captured
                                opacity: isClicked ? '0.8' : isHovered ? '0.6' : '0.3',
                                transition: 'opacity 0.2s ease, border-color 0.2s ease',
                                boxShadow: isHovered && isClicked ? '0 0 0 2px rgba(156, 39, 176, 0.5)' : // Purple glow
                                  isHovered ? '0 0 0 2px rgba(255, 87, 51, 0.5)' : // Orange glow
                                  isClicked ? '0 0 0 2px rgba(33, 150, 243, 0.5)' : // Blue glow
                                  'none',
                              }}
                              onClick={(e) => handleBoxClick(box, e)}
                              title={box.text ? "Click to read text aloud" : "No text available"}
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
            <div className="w-full lg:w-1/4 h-[60vh] bg-white p-4 rounded-lg shadow flex flex-col">
              {isLoading ? (
                /* Loading state for Chat */
                <div className="flex-grow flex flex-col items-center justify-center text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mb-3"></div>
                  <p className="text-gray-700 font-medium mb-1">Preparing chat functionality...</p>
                  <p className="text-sm text-gray-500">You&apos;ll be able to chat with your document once analysis is complete.</p>
                </div>
              ) : analysisResult && chatFileHash ? (
                <>
                  <h2 className="text-lg font-semibold mb-3 text-gray-800">Chat with Document</h2>
                  
                  {/* Chat History Display */}
                  <div className="flex-grow overflow-y-auto border border-gray-200 rounded p-3 mb-3 bg-gray-50">
                    {chatHistory.map((msg, index) => (
                      <div key={index} className={`mb-3 ${msg.sender === 'user' ? 'text-right' : 'text-left'}`}> 
                        <span 
                          className={`inline-block p-2 rounded-lg max-w-full break-words ${ 
                            msg.sender === 'user' 
                            ? 'bg-blue-500 text-white cursor-pointer hover:bg-blue-600' // Make user messages clickable
                            : 'bg-gray-200 text-gray-800 cursor-pointer hover:bg-gray-300' // Keep bot messages clickable
                          }`}
                          onClick={() => handleChatMessageClick(msg)} // Add click handler to both
                          title="Click to read aloud" // Add tooltip to both
                        >
                          {/* Render bot messages using ReactMarkdown */}
                          {msg.sender === 'bot' ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {msg.text}
                            </ReactMarkdown>
                          ) : (
                            msg.text // Render user messages as plain text
                          )}
                          
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
                  <form onSubmit={handleChatSubmit} className="flex items-center">
                    <input
                      type="text"
                      value={chatQuery}
                      onChange={(e) => setChatQuery(e.target.value)}
                      placeholder="Ask a question..."
                      className="flex-grow shadow appearance-none border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline mr-2"
                      disabled={isChatLoading || isRecording}
                      required
                    />
                    {/* Microphone Button */}
                    <button
                      type="button"
                      onClick={isRecording ? stopRecordingManually : startRecording}
                      disabled={!recognitionRef.current || isChatLoading}
                      title={isRecording ? "Stop Recording" : "Record Question"}
                      className={`p-2 rounded focus:outline-none focus:shadow-outline mr-2 transition-colors duration-200 ${ 
                        isRecording 
                          ? 'bg-red-500 hover:bg-red-700 text-white' 
                          : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                      } ${!recognitionRef.current ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <svg 
                        className={`w-5 h-5 ${isRecording ? 'animate-pulse' : ''}`} 
                        fill="currentColor" 
                        viewBox="0 0 20 20" 
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8h-1a6 6 0 11-12 0H3a7.001 7.001 0 006 6.93V17H7v1h6v-1h-2v-2.07z" clipRule="evenodd" />
                      </svg>
                    </button>
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
                  
                  {/* Voice Selection - Always visible */}
                  <div className="mt-4 border-t border-gray-200 pt-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-gray-700">Text-to-Speech Voice:</span>
                      <div className="relative">
                        <button
                          className="text-sm bg-blue-600 text-white px-3 py-1 rounded shadow-sm hover:bg-blue-700 transition-colors duration-200 flex items-center"
                          onClick={toggleVoiceSelector}
                          title="Change voice"
                        >
                          <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
                          </svg>
                          {selectedVoice ? selectedVoice.name.split(' ').slice(0, 2).join(' ') : 'Select Voice'}
                        </button>
                        
                        {/* Voice Selector Dropdown */}
                        {showVoiceSelector && (
                          <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-xl z-50 w-64 p-3 border border-gray-200">
                            <div className="flex justify-between items-center mb-2">
                              <h3 className="font-medium text-gray-800">Select Voice</h3>
                              <button 
                                onClick={() => setShowVoiceSelector(false)}
                                className="text-gray-500 hover:text-gray-700"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                                </svg>
                              </button>
                            </div>
                            
                            {availableVoices.length > 0 ? (
                              <div className="max-h-64 overflow-y-auto">
                                {availableVoices
                                  .filter(voice => voice.lang.startsWith('en'))
                                  .map((voice, index) => (
                                  <div 
                                    key={`${voice.name}-${index}`}
                                    className={`p-2 cursor-pointer hover:bg-gray-100 rounded ${selectedVoice === voice ? 'bg-blue-100' : ''}`}
                                    onClick={() => {
                                      setSelectedVoice(voice);
                                      setShowVoiceSelector(false);
                                      console.log('Voice selected:', voice.name);
                                    }}
                                  >
                                    <div className="font-medium text-gray-900">{voice.name}</div>
                                    <div className="text-xs text-gray-700 font-medium">{voice.lang} {voice.default ? '(Default)' : ''}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-gray-700">No voices available</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {selectedVoice && (
                      <div className="mt-1 text-xs text-gray-500">
                        Current: {selectedVoice.name} ({selectedVoice.lang})
                      </div>
                    )}
                  </div>
                  
                  {/* Reading Speed Control */}
                  <div className="mt-3 border-t border-gray-200 pt-3">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm font-medium text-gray-700">Reading Speed:</span>
                      <span className="text-xs font-medium text-gray-700">{speechRate.toFixed(1)}x</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.1"
                      value={speechRate}
                      onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                      <span>Slower</span>
                      <span>Faster</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col items-center justify-center h-full text-center text-gray-500">
                    <svg className="w-12 h-12 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path>
                    </svg>
                    <p className="text-sm mb-2">Chat will appear here</p>
                    <p className="text-xs">Click &quot;Analyze Document&quot; to enable chat</p>
                  </div>
                </>
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
