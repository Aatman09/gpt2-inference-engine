from pydantic import BaseModel , Field
from enum import Enum

class HealthResponse(BaseModel):
    status : str 
    model_loaded : bool

class ModelName(str, Enum):
    GPT2 = "gpt2"
    GPT2_Medium = "gpt2-medium"
    GPT2_Large = "gpt2-large"
    GPT2_XL = "gpt2-xl"

class PredictRequests(BaseModel):
    model_name : ModelName
    predict : str
    temprature : float | None = 0.8 
    top_k  : int | None = 50

    

