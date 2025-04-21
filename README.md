# SpeakEasy  
*A More Intuitive PDF Experience*

---

## Overview

PDFs were developed with rendering consistency and system compatibility in mind. However, accessibility was never a core focus of the format. Today, most research papers and documents are stored as PDFs, which poses significant challenges for individuals with visual impairments or those relying on screen readers.

To address this issue, we introduce **SpeakEasy** — a system that enables users to interact with PDFs using both voice and text, making academic and informational content more accessible to visually impaired members of society.

---

## Technologies Used

- **HURIDOCS**  
  Used to segment the PDF into meaningful sections and extract structured text and metadata.

- **Google Gemini**  
  Powers the summarization of extracted text and handles user queries through conversational interaction.

- **Text-to-Speech (TTS)**  
  Converts summaries and responses into speech for auditory consumption.

- **Speech-to-Text (STT)**  
  Translates user voice queries into text for interpretation by the system.


---

## To Run

```
git clone https://github.com/das-ag/SpeakEasy.git
cd backend
python app.py &
cd ../frontend
npm run
```

---

## Team Members

- Agastya Das  
- Ming Yan  
- Ashwin Ravindra Bharadwaj
- Ankit Sinha  

---

## Acknowledgment

This project was developed as part of the *Human-Computer Interaction* course (CS5170) at Northeastern University.
