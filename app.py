import os
import io
import uuid
import json
import base64
import requests
from pathlib import Path
from dotenv import load_dotenv
from flask import Flask, request, send_from_directory, render_template, jsonify, Response
import cv2
import numpy as np
import logging

load_dotenv()

logging.basicConfig(level=logging.INFO)

APP_DIR = Path(__file__).parent
UPLOAD_DIR = APP_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
MODEL_NAME = os.getenv("OLLAMA_MODEL", "qwen3")

app = Flask(__name__, static_folder=str(APP_DIR / "static"), template_folder=str(APP_DIR / "templates"))


def call_qwen_parse_stream(instruction):
    """Call the local Ollama /api/chat with a tools definition so the model can return a tool call.
    This generator yields tuples (type, payload) where type is 'chunk' (text chunk),
    'tool_call' (the detected tool call object), or 'error'.
    """
    tools = [
        {
            "type": "function",
            "function": {
                "name": "edit_image",
                "description": "Edit the uploaded image. Return a JSON object with operation and params.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "operation": {
                            "type": "string",
                            "enum": ["blur", "grayscale", "pixelate", "flip", "rotate"]
                        },
                        "params": { "type": "object" }
                    },
                    "required": ["operation"]
                }
            }
        }
    ]

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": "You are an assistant that converts a user's instruction into a tool call 'edit_image' with a JSON arguments object. Use the tool to return only the arguments JSON in the tool call."},
            {"role": "user", "content": instruction}
        ],
        "tools": tools,
        "stream": True
    }

    try:
        with requests.post(f"{OLLAMA_URL}/api/chat", json=payload, stream=True, timeout=60) as r:
            r.raise_for_status()
            # stream lines of JSON objects
            for line in r.iter_lines(decode_unicode=True):
                if not line:
                    continue
                # Each line is a JSON object
                try:
                    obj = json.loads(line)
                except Exception:
                    yield ('chunk', line)
                    continue

                # If there's a message with tool_calls, capture it
                message = obj.get('message') if isinstance(obj, dict) else None
                if message:
                    tool_calls = message.get('tool_calls')
                    if tool_calls and isinstance(tool_calls, list) and len(tool_calls) > 0:
                        # return the first tool call
                        yield ('tool_call', tool_calls[0])
                        return
                    # Also yield assistant text chunks
                    content = message.get('content')
                    if content:
                        yield ('chunk', content)
            # if ended without tool_call
            yield ('chunk', '')
    except Exception as e:
        yield ('error', str(e))


def apply_operation(image_path, command):
    # Load with OpenCV from bytes (safer cross-platform than np.fromfile)
    image_path = Path(image_path)
    data = image_path.read_bytes()
    nparr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(f"Unable to read image: {image_path}")
    logging.info(f"apply_operation: loaded image {image_path} shape={img.shape}")

    op = command.get('operation')
    params = command.get('params', {}) or {}

    if op == 'grayscale':
        out = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        out = cv2.cvtColor(out, cv2.COLOR_GRAY2BGR)
    elif op == 'blur':
        k = int(params.get('ksize', 15))
        if k % 2 == 0:
            k += 1
        out = cv2.GaussianBlur(img, (k, k), 0)
    elif op == 'pixelate':
        scale = float(params.get('scale', 0.1))
        h, w = img.shape[:2]
        small = cv2.resize(img, (max(1, int(w*scale)), max(1, int(h*scale))), interpolation=cv2.INTER_NEAREST)
        out = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    elif op == 'flip':
        mode = params.get('mode', 'horizontal')
        if mode == 'horizontal':
            out = cv2.flip(img, 1)
        elif mode == 'vertical':
            out = cv2.flip(img, 0)
        else:
            out = img
    elif op == 'rotate':
        angle = float(params.get('angle', 90))
        # Rotate and expand canvas so the entire rotated image fits.
        (h, w) = img.shape[:2]
        (cX, cY) = (w / 2.0, h / 2.0)
        M = cv2.getRotationMatrix2D((cX, cY), angle, 1.0)
        # compute the new bounding dimensions of the image
        abs_cos = abs(M[0, 0])
        abs_sin = abs(M[0, 1])
        # new width and height bounds
        new_w = int((h * abs_sin) + (w * abs_cos))
        new_h = int((h * abs_cos) + (w * abs_sin))
        # adjust the rotation matrix to take into account translation
        M[0, 2] += (new_w / 2) - cX
        M[1, 2] += (new_h / 2) - cY
        out = cv2.warpAffine(img, M, (new_w, new_h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    else:
        raise ValueError(f"Unsupported operation: {op}")

    # Encode to PNG bytes
    is_success, im_buf_arr = cv2.imencode('.png', out)
    if not is_success:
        raise ValueError('Failed to encode output image')
    return im_buf_arr.tobytes()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/upload', methods=['POST'])
def upload():
    f = request.files.get('image')
    instruction = request.form.get('instruction', '')
    if f is None:
        return jsonify({'error': 'no file'}), 400
    ident = str(uuid.uuid4())
    save_path = UPLOAD_DIR / f"{ident}_{f.filename}"
    f.save(str(save_path))
    return jsonify({'id': ident, 'filename': f.filename})


@app.route('/stream')
def stream():
    """SSE endpoint: expects query ?id=<id>&filename=<filename>&instruction=<instruction encoded>
    The client should first upload the file then call this endpoint providing the id and filename.
    """
    ident = request.args.get('id')
    filename = request.args.get('filename')
    source = request.args.get('source', 'original')
    instruction = request.args.get('instruction', '')
    if not ident:
        return "Missing id", 400
    # filename is optional when source=edited (we'll use <id>_edited.png)
    if source != 'edited' and not filename:
        return "Missing filename for original source", 400

    # Determine which file to use as the input image.
    # source=original -> use the originally uploaded file: <id>_<original_filename>
    # source=edited -> use the last edited result saved as <id>_edited.png
    if source == 'edited':
        file_path = UPLOAD_DIR / f"{ident}_edited.png"
        if not file_path.exists():
            return "Edited image not found", 404
    else:
        file_path = UPLOAD_DIR / f"{ident}_{filename}"
        if not file_path.exists():
            return "Original file not found", 404

    def gen():
        # Initial progress
        yield f"data: {json.dumps({'type':'ai','text':'Received image, parsing instruction...'})}\n\n"

        # Call model to parse using streaming tool-calling
        tool_call = None
        for kind, payload in call_qwen_parse_stream(instruction):
            if kind == 'chunk':
                # forward chunk text to client
                try:
                    txt = payload if isinstance(payload, str) else json.dumps(payload)
                except Exception:
                    txt = str(payload)
                yield f"data: {json.dumps({'type':'ai','text': txt})}\n\n"
            elif kind == 'tool_call':
                tool_call = payload
                yield f"data: {json.dumps({'type':'ai','text': 'Received tool call: ' + json.dumps(tool_call)})}\n\n"
                break
            elif kind == 'error':
                yield f"data: {json.dumps({'type':'ai','text': 'Error parsing instruction: ' + str(payload)})}\n\n"
                return

        if tool_call is None:
            yield f"data: {json.dumps({'type':'ai','text': 'No tool call returned by model.'})}\n\n"
            return

        # Extract function arguments
        func = tool_call.get('function') if isinstance(tool_call, dict) else None
        if not func:
            yield f"data: {json.dumps({'type':'ai','text': 'Malformed tool_call object.'})}\n\n"
            return

        args = func.get('arguments') or {}
        # At this point args should be a dict like {"operation": "grayscale", "params": {...}}
        parsed = args

        # Apply operation
        yield f"data: {json.dumps({'type':'ai','text': 'Applying operation...'})}\n\n"
        try:
            out_bytes = apply_operation(file_path, parsed)
        except Exception as e:
            yield f"data: {json.dumps({'type':'ai','text': 'Error applying operation: ' + str(e)})}\n\n"
            return

        # Save full image to uploads and create a thumbnail
        out_name = f"{ident}_edited.png"
        out_path = UPLOAD_DIR / out_name
        with open(out_path, 'wb') as fh:
            fh.write(out_bytes)
        logging.info(f"Saved edited image to {out_path} ({len(out_bytes)} bytes)")

        # Create thumbnail using OpenCV
        nparr = np.frombuffer(out_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
        if img is None:
            yield f"data: {json.dumps({'type':'ai','text': 'Failed to decode edited image for thumbnail.'})}\n\n"
            return
        logging.info(f"Thumbnail generation: edited image shape={img.shape}")
        h, w = img.shape[:2]
        max_thumb_w = 400
        if w > max_thumb_w:
            scale = max_thumb_w / float(w)
            thumb = cv2.resize(img, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_AREA)
        else:
            thumb = img

        is_success, thumb_buf = cv2.imencode('.png', thumb)
        if not is_success:
            yield f"data: {json.dumps({'type':'ai','text': 'Failed to encode thumbnail.'})}\n\n"
            return

        thumb_b64 = base64.b64encode(thumb_buf.tobytes()).decode('ascii')
        thumb_data_url = f"data:image/png;base64,{thumb_b64}"

        full_url = f"/uploads/{out_name}"
        yield f"data: {json.dumps({'type':'image','thumbnail': thumb_data_url, 'full_url': full_url})}\n\n"

        # yield f"data: {json.dumps({'type':'ai','text':'Done'})}\n\n"

    return Response(gen(), mimetype='text/event-stream')


@app.route('/chat')
def chat_stream():
    """SSE endpoint for chat-only text streams. Expects query ?instruction=<text>
    This will call the model (OLLAMA) with a simple system+user prompt and stream chunks
    back to the client as {'type':'ai','text':...} events.
    """
    instruction = request.args.get('instruction', '')
    if not instruction:
        return "Missing instruction", 400

    def gen():
        yield f"data: {json.dumps({'type':'ai','text':'Parsing instruction...'})}\n\n"
        # Reuse call_qwen_parse_stream to stream responses; it yields ('chunk', text) etc
        try:
            for kind, payload in call_qwen_parse_stream(instruction):
                if kind == 'chunk':
                    txt = payload if isinstance(payload, str) else json.dumps(payload)
                    yield f"data: {json.dumps({'type':'ai','text': txt})}\n\n"
                elif kind == 'tool_call':
                    # If the model returned a tool_call in chat-only mode, surface it as text
                    yield f"data: {json.dumps({'type':'ai','text': 'Tool call: ' + json.dumps(payload)})}\n\n"
                elif kind == 'error':
                    yield f"data: {json.dumps({'type':'ai','text': 'Error: ' + str(payload)})}\n\n"
            # yield f"data: {json.dumps({'type':'ai','text':'Done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'ai','text':'Stream error: ' + str(e)})}\n\n"

    return Response(gen(), mimetype='text/event-stream')


@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory(str(APP_DIR / 'static'), filename)


@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    # serve files saved in uploads folder (edited results and originals)
    resp = send_from_directory(str(UPLOAD_DIR), filename)
    # ensure browsers don't cache uploads so the client always fetches the latest edited image
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    return resp


if __name__ == '__main__':
    app.run(debug=True, port=5000)
