from pydantic import BaseModel , Field
from enum import Enum

class HealthResponse(BaseModel):
    status : str
    model_loaded : bool
    loaded_models : list[str] = []

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
