from pydantic import BaseModel , Field
from enum import Enum
from datetime import datetime
from uuid import UUID

class HealthResponse(BaseModel):
    status : str
    model_loaded : bool
    loaded_models : list[str] = []
    # lets the frontend hide the "Continue with Google" button when the server
    # has no OAuth credentials, rather than offering a link that 503s
    google_enabled : bool = False

# values must match the keys in engine/registry.py's _ENGINE_SPECS exactly --
# this enum is the only validation those keys get before a dict lookup
class ModelName(str, Enum):
    GPT2 = "gpt2"
    QWEN_2_5 = "qwen2.5-0.5b-instruct"
    SMOLLM2 = "smollm2-360m-instruct"

class PredictRequests(BaseModel):
    model_name : ModelName
    predict : str
    session_id : str
    temprature : float | None = 0.8
    top_k  : int | None = 50
    max_new_tokens : int = 256
    # only honored by GPT2 (the only engine with supports_cache_toggle=True);
    # ignored by the HF-backed models
    use_cache : bool = True

class StopRequest(BaseModel):
    session_id : str

# --- Phase 1: conversation persistence (see docs/ROADMAP.md) ---

class ConversationSummary(BaseModel):
    """List-view shape -- no messages payload, keeps GET /conversations light."""
    id : UUID
    title : str
    updated_at : datetime

class Conversation(ConversationSummary):
    """Full shape -- returned by create and get-by-id."""
    messages : list[dict]
    created_at : datetime

class CreateConversationRequest(BaseModel):
    title : str | None = None

class AppendMessageRequest(BaseModel):
    role : str
    content : str

class RenameConversationRequest(BaseModel):
    title : str

# --- Phase 3: auth (see docs/ROADMAP.md) ---

class SignupRequest(BaseModel):
    email : str
    password : str
    name : str

class LoginRequest(BaseModel):
    email : str
    password : str

class UserResponse(BaseModel):
    id : UUID
    email : str
    name : str
