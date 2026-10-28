import asyncio
import json
import logging
from typing import Optional

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from valyu import SearchResponse, Valyu

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s", force=True
)
logger = logging.getLogger(__name__)

mcp = FastMCP("valyu-mcp")
valyu: Optional[Valyu] = None


async def make_valyu_request(
    query: str, max_num_results: int = 5, max_price: int = 10
) -> SearchResponse:
    """
    Initiates a request to the Valyu API, incorporating error handling and logging for debugging purposes.

    Parameters:
    - query (str): The search query to be sent to the Valyu API.
    - max_num_results (int, optional): The maximum number of results to be returned. Defaults to 5.
    - max_price (int, optional): The maximum price for the results. Defaults to 10.

    Returns:
    - SearchResponse: A successful response from the Valyu API. Failures raise ToolError.
    """
    if valyu is None:
        raise ToolError(
            "Search requires VALYU_API_KEY. Configure it in the server environment "
            "and restart the server."
        )

    try:
        response = await asyncio.to_thread(
            valyu.search,
            query=query,
            search_type="all",
            max_num_results=max_num_results,
            max_price=max_price,
        )
    except Exception as e:
        logger.error("Valyu request failed (%s)", type(e).__name__)
        raise ToolError(
            "Valyu search failed. Check service availability and try again."
        ) from None

    if response is None or not response.success:
        logger.warning("Valyu search returned an unsuccessful response")
        raise ToolError(
            "Valyu search failed. Check your API key, account balance, source access, "
            "and service availability."
        )
    return response


def format_valyu_results(data: SearchResponse) -> str:
    """
    Formats the Valyu context results for feeding back to the model as context.

    Parameters:
    - data (SearchResponse): The SearchResponse object received from the Valyu API.

    Returns:
    - str: A formatted string containing the Valyu context results.
    """
    if not data.results:
        return "No results found."

    results = []
    for result in data.results:
        content = result.content
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False)
        else:
            content = content or result.description or ""
        results.append(
            f"""Title: {result.title}
Content: {content}
URL: {result.url}"""
        )

    formatted_output = "\n\n".join(results)
    return formatted_output


@mcp.tool()
async def valyu_context(query: str, max_num_results: int = 5) -> str:
    """
    A powerful search tool that provides relevant, up-to-date information from across the web and proprietary data sources.
    Use this tool whenever you need to:
    1. Find current information about any topic
    2. Research specific questions or concepts
    3. Get context about companies, technologies, or trends
    4. Verify facts or gather supporting information
    5. Access real-world data and examples

    Parameters:
    - query (str): The search query. Be specific and detailed in your query for best results.
    - max_num_results (int, optional): Maximum number of results to return (default: 5, clamped to 1-5).

    Returns:
    - str: Formatted search results including titles, content, and source URLs.
    """
    if not query.strip():
        raise ToolError("The search query must not be empty.")

    max_num_results = min(max(1, max_num_results), 5)
    data = await make_valyu_request(query, max_num_results, 10)
    logger.info("Valyu search returned %d results", len(data.results))
    return format_valyu_results(data)


if __name__ == "__main__":
    import os

    VALYU_API_KEY = os.getenv("VALYU_API_KEY")
    try:
        if VALYU_API_KEY:
            valyu = Valyu(api_key=VALYU_API_KEY)
            logger.info("Server initialized successfully")
        else:
            logger.warning("VALYU_API_KEY is not configured; search is disabled")

        # Initialize and run the server using stdio transport
        mcp.run(transport="stdio")
    except Exception as e:
        logger.error("Fatal error running MCP server (%s)", type(e).__name__)
        exit(1)
