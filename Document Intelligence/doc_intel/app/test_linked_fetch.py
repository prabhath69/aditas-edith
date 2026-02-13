"""Test script to verify linked document fetching works"""
import sys
sys.path.insert(0, '.')

from document_parser import parse_pdf
from bs4 import BeautifulSoup
import requests
import re

def extract_urls_from_content(text: str) -> list[str]:
    """Extract URLs from text content"""
    urls = []
    url_pattern = r'https?://[^\s<>"\')\]]+(?:\.[^\s<>"\')\]]+)*'
    found_urls = re.findall(url_pattern, text)
    for url in found_urls:
        url = url.rstrip('.,;:)')
        if url and url not in urls:
            urls.append(url)
    return urls

def fetch_linked_document_content(url: str, main_doc_url: str) -> list[str]:
    """Fetch content from a linked URL (PDF or webpage)"""
    if url == main_doc_url:
        return []
    
    try:
        print(f"  [Fetching linked document: {url}]")
        
        if url.lower().endswith('.pdf') or 'export?format=pdf' in url.lower():
            linked_pages = parse_pdf(url)
            return linked_pages if linked_pages else []
        else:
            response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=30)
            response.raise_for_status()
            
            content_type = response.headers.get('Content-Type', '')
            if 'application/pdf' in content_type:
                linked_pages = parse_pdf(url)
                return linked_pages if linked_pages else []
            else:
                soup = BeautifulSoup(response.text, 'html.parser')
                text = soup.get_text(separator=' ', strip=True)
                chunk_size = 2000
                chunks = [text[i:i+chunk_size].strip() for i in range(0, len(text), chunk_size)]
                return [c for c in chunks if c]
    except Exception as e:
        print(f"  [Failed to fetch {url}: {e}]")
        return []

# Test with the Google Docs PDF
doc_url = "https://docs.google.com/document/d/1zoBpF8iSPtqk8RDck692zJ_V_htjWUjV/export?format=pdf"

print("=" * 60)
print("Testing linked document fetching")
print("=" * 60)

print(f"\n1. Parsing main document: {doc_url}")
pages = parse_pdf(doc_url)
print(f"   Main document has {len(pages)} pages")

print(f"\n2. Extracting URLs from content...")
all_text = "\n".join(pages)
urls = extract_urls_from_content(all_text)
print(f"   Found {len(urls)} URLs")

print(f"\n3. Fetching linked documents...")
for url in urls:
    linked_content = fetch_linked_document_content(url, doc_url)
    if linked_content:
        print(f"   SUCCESS: Got {len(linked_content)} chunks from {url[:50]}...")
        # Show preview of first chunk
        if linked_content[0]:
            preview = linked_content[0][:200].replace('\n', ' ')
            print(f"   Preview: {preview}...")
        # Add to pages
        for chunk in linked_content:
            pages.append(f"[Source: {url}]\n{chunk}")
    else:
        print(f"   FAILED: No content from {url[:50]}...")

print(f"\n4. Total pages after including linked content: {len(pages)}")

# Search for Brahmaputra
print(f"\n5. Searching for 'Brahmaputra' in content...")
for i, page in enumerate(pages):
    if 'brahmaputra' in page.lower():
        print(f"   FOUND in page {i+1}!")
        # Find the context
        idx = page.lower().find('brahmaputra')
        start = max(0, idx - 100)
        end = min(len(page), idx + 200)
        print(f"   Context: ...{page[start:end]}...")
        break
else:
    print("   NOT FOUND in any page")
