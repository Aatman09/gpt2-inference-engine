import sys
from pathlib import Path

# Point to project root where model_kv.py lives
project_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(project_root))

import torch
import tiktoken
from fastapi import FastAPI, status
from contextlib import asynccontextmanager

from model_kv import GPT
from .schemas import HealthResponse, PredictRequests

from fastapi.middleware.cors import CORSMiddleware

device = "cuda" if torch.cuda.is_available() else "cpu"
enc = tiktoken.get_encoding("gpt2")


def load_model(model_name: str):
    model = GPT.from_pretrained(model_name)
    model.eval()
    model.to(device)
    return model


my_models = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    my_models["gpt2"] = load_model("gpt2")
    yield
    my_models.clear()
    torch.cuda.empty_cache()
    


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"])

@app.get("/health", response_model=HealthResponse, status_code=status.HTTP_200_OK)
def health():
    return HealthResponse(status="ok", model_loaded=bool(my_models))


@app.post("/predict")
def predict(request: PredictRequests):
    model_name = request.model_name.value

    # reuse the preloaded model instead of reloading weights on every request;
    # lazily load + cache any variant beyond the default one warmed in lifespan
    model = my_models.get(model_name)
    if model is None:
        model = load_model(model_name)
        my_models[model_name] = model

    tokens = enc.encode(request.predict)
    idx = torch.tensor(tokens, dtype=torch.long, device=device).unsqueeze(0)

    with torch.no_grad():
        out = model.generate(idx, max_new_tokens=50, temperature=request.temprature, top_k=request.top_k)

    generated_tokens = out[0, len(tokens):].tolist()
    predicted_text = enc.decode(generated_tokens)

    return {"predicted": predicted_text}
