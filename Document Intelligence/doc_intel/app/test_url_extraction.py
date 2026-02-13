"""Test script to verify URL extraction from PDF"""
import sys
sys.path.insert(0, '.')

from document_parser import parse_pdf
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

# Test with the Google Docs PDF
doc_url = "https://docs.google.com/document/d/1zoBpF8iSPtqk8RDck692zJ_V_htjWUjV/export?format=pdf"

print("=" * 60)
print("Testing PDF parsing and URL extraction")
print("=" * 60)

print(f"\n1. Parsing PDF: {doc_url}")
pages = parse_pdf(doc_url)

print(f"\n2. PDF parsed successfully: {len(pages)} pages")

for i, page in enumerate(pages):
    print(f"\n--- Page {i+1} content ---")
    print(page[:1000] if len(page) > 1000 else page)
    print("--- End of page ---")

print("\n3. Extracting URLs from content...")
all_text = "\n".join(pages)
urls = extract_urls_from_content(all_text)

print(f"\n4. Found {len(urls)} URLs:")
for url in urls:
    print(f"   - {url}")

if not urls:
    print("\n   WARNING: No URLs found! The links might be embedded as PDF annotations")
    print("   Check if [EXTRACTED LINKS FROM THIS PAGE] section exists in the page content")
