from sentence_transformers import SentenceTransformer
import faiss
import numpy as np
import os
from functools import lru_cache
os.environ["TOKENIZERS_PARALLELISM"] = "false"
model = SentenceTransformer("intfloat/e5-large-v2")

@lru_cache(maxsize=100)
def get_embeddings(texts: tuple) -> np.array:  # Note: texts must be hashable
    return model.encode(list(texts), convert_to_tensor=False)

def build_faiss_index(embeddings):
    dim = embeddings[0].shape[0]
    index = faiss.IndexFlatL2(dim)
    index.add(np.array(embeddings))
    return index
