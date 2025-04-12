---
config:
  theme: redux-color
  look: neo
---
sequenceDiagram
  participant User as User
  participant Frontend as Frontend
  participant Backend as Backend
  participant RAG as RAG
  participant Huridocs as Huridocs
  User ->> Frontend: Upload PDF
  Frontend ->> Backend: Send PDF to backend
  Backend ->> Huridocs: Analyze PDF Structure
  Huridocs -->> Backend: Cache Analysis Results
  Backend ->> RAG: Use analysis for RAG Indexing, Vector Storage
  Backend ->> User: Display PDF Structure
  Backend ->> Frontend: Generate Section Summaries using LLM. <br>Cache and send to Frontend
  User ->> Backend: Query Chat <br>
  Backend ->> RAG: Embed Query, Retrieve relevant knowledge
  RAG ->> Frontend: Render formatted knowlege from LLM/RAG
  User ->> Frontend: Hover / Click on section
  Frontend ->> User: Display Section Summary,<br>Read contents
