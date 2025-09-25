AI Image Editor (Qwen3 via Ollama)

This small Flask app accepts an image and a natural-language instruction, calls a local Ollama-hosted Qwen3 model to convert the instruction into a JSON operation, applies the operation with OpenCV, and streams progress and the resulting image back to the browser using Server-Sent Events (SSE).

Setup

1. Create a Python 3.12 venv named `aiAgent` (if you have Python 3.12 installed). If you don't have 3.12, use the available Python version.

   python3.12 -m venv ~/venvs/aiAgent
   source ~/venvs/aiAgent/bin/activate

2. Install dependencies:

   pip install -r requirements.txt

3. Copy `.env.example` to `.env` and edit if your Ollama URL or model differ.

4. Run the app:

   python app.py

5. Open http://localhost:5000 in your browser.

Notes
- The app expects an Ollama HTTP API available at `OLLAMA_URL` (default http://localhost:11434) and a model called `qwen-3`.
- The model is asked to return only a JSON object describing the operation, e.g. {"operation":"grayscale","params":{}}

Security: This is a demo. Don't expose the endpoint to untrusted networks without adding authentication and limits.


python3 -m venv ~/venvs/aiAgent && source ~/venvs/aiAgent/bin/activate