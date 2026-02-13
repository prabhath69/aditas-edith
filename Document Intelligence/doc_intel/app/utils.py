import re
def chunk_text(text, chunk_size=500, overlap=100):
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_size - overlap):
        chunk = " ".join(words[i:i+chunk_size])
        chunks.append(chunk)
    return chunks

def clean_response(text: str) -> str:
    text = text.strip().replace('\n', ' ').replace('“', '"').replace('”', '"')
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

def contains_api_or_url(text: str) -> bool:
    """
    Returns True if the text contains interactive API documentation patterns.
    """
    # REST API endpoint patterns with HTTP methods
    api_endpoint_pattern = re.compile(
        r'\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+https?://', re.IGNORECASE
    )
    
    # Instructional API patterns
    instructional_patterns = [
        r'\bcall\s+this\s+endpoint',
        r'\bcall\s+the\s+api',
        r'\bmake\s+a\s+request\s+to',
        r'\bendpoint\s+to\s+get',
        r'\bapi\s+response',
        r'\b(GET|POST|PUT|DELETE|PATCH)\s+https?://',
        r'\bcurl\s+-[XH]',
        r'\b(request|response)\s*(body|payload|headers?)',
        r'\b(authorization|auth)\s*:\s*(bearer|basic|api[_-]?key)',
        r'\bapi[_-]?key\s*[:=]',
        r'\b(query\s*param|path\s*param|header\s*param)',
        r'\b(endpoint|api)\s*:\s*https?://',
        r'\b(base\s*url|baseurl)\s*:\s*https?://',
        r'\b(content-type|accept)\s*:\s*application/',
        r'\b(status\s*code|http\s*status)\s*:\s*\d{3}',
    ]
    
    # Check for any instructional API pattern
    for pattern in instructional_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            return True
    
    return False

