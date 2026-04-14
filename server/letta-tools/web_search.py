"""
Web search using the local GPU-AI search MCP service.

Replaces Letta's built-in web_search (which uses EXA API) with the local
search service at mcp.baisoln.com/search/search (Tavily-shaped REST API).
"""
import os
import json


def web_search(query: str, max_results: int = 5) -> str:
    """Search the web for current information.

    Args:
        query: Search query string.
        max_results: Maximum number of results to return (default 5).

    Returns:
        JSON string with search results including titles, URLs, and snippets.
    """
    import urllib.request
    import urllib.error

    search_url = os.environ.get("SEARCH_API_URL", "https://mcp.baisoln.com/search/search")
    api_key = os.environ.get("SEARCH_API_KEY", "")

    headers = {
        "Content-Type": "application/json",
    }
    if api_key:
        headers["X-API-Key"] = api_key

    payload = json.dumps({
        "query": query,
        "max_results": max_results,
        "search_depth": "basic",
    }).encode("utf-8")

    try:
        req = urllib.request.Request(search_url, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        results = data.get("results", [])
        if not results:
            return json.dumps({"query": query, "results": [], "message": "No results found"})

        formatted = []
        for r in results[:max_results]:
            formatted.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("content", r.get("snippet", ""))[:500],
            })

        return json.dumps({"query": query, "results": formatted})

    except urllib.error.URLError as e:
        return json.dumps({"error": f"Search failed: {str(e)}"})
    except Exception as e:
        return json.dumps({"error": f"Search error: {str(e)}"})
