"""
This the local Python MCP server, not the live deployed version. For the deployed version see mcp/cloudflare
"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlparse
from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.prompts import Message
from fastmcp.utilities.types import Image
from mcp.types import ToolAnnotations
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page, async_playwright
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))


@asynccontextmanager
async def browser_lifespan(server):
    try:
        yield {}
    finally:
        await close_browser()


mcp = FastMCP(
    "Browser",
    instructions=(
        "Drive a real Chromium browser. Call open_page first, read the "
        "snapshot, then target elements by the role and name shown in it."
    ),
    mask_error_details=True,
    lifespan=browser_lifespan,
)
ALLOWED = {
    d.strip() for d in os.environ.get("ALLOWED_DOMAINS", "").split(",") if d.strip()
}
HEADLESS = os.environ.get("HEADLESS", "true").strip().lower() == "true"
_state: dict = {}
_browser_lock = asyncio.Lock()

Role = Literal["button", "link", "textbox", "checkbox", "combobox", "tab", "menuitem", "form"]


async def get_page() -> Page:
    """Start the browser on first use and reuse one page afterwards."""
    async with _browser_lock:
        if "page" in _state:
            if _state["browser"].is_connected() and not _state["page"].is_closed():
                return _state["page"]
            await _close_browser_state()
        try:
            _state["pw"] = await async_playwright().start()
            _state["browser"] = await _state["pw"].chromium.launch(headless=HEADLESS)
            _state["page"] = await _state["browser"].new_page()
        except BaseException:
            await _close_browser_state()
            raise
        return _state["page"]


async def _close_browser_state() -> None:
    """Release only the browser and Playwright driver owned by this server."""
    state = _state.copy()
    _state.clear()
    try:
        if browser := state.get("browser"):
            await browser.close()
    finally:
        if pw := state.get("pw"):
            await pw.stop()


@mcp.tool(timeout=20.0)
async def close_browser() -> str:
    """Close this server's browser and driver, if running. Safe to call repeatedly."""
    async with _browser_lock:
        await _close_browser_state()
    return "Browser closed."


def check_allowed(url: str) -> None:
    host = urlparse(url).hostname or ""
    if ALLOWED and not any(host == d or host.endswith("." + d) for d in ALLOWED):
        raise ToolError(f"{host} is not in ALLOWED_DOMAINS.")


async def snapshot(page: Page) -> str:
    return await page.locator("body").aria_snapshot()


async def wait_for_initial_textboxes(page: Page, timeout_ms: float = 15000) -> None:
    """Allow initially disabled textboxes to initialize before reporting page state."""
    try:
        # This locator is re-evaluated while waiting: it disappears when all
        # visible textboxes are enabled. Ready pages return immediately.
        await page.get_by_role("textbox", disabled=True).first.wait_for(
            state="hidden", timeout=timeout_ms
        )
    except PlaywrightTimeoutError:
        # A genuinely disabled field must still be visible in the snapshot.
        pass


@mcp.tool(timeout=45.0)
async def open_page(
    url: str,
    ctx: Context,
) -> dict:
    """Open a URL; allow disabled textboxes up to 15s to initialize; return a snapshot."""
    check_allowed(url)
    page = await get_page()
    await ctx.info(f"Navigating to {url}")
    try:
        await page.goto(url, wait_until="domcontentloaded")
    except PlaywrightError as e:
        raise ToolError(f"Could not load {url}: {e.message}")
    await wait_for_initial_textboxes(page)
    return {
        "url": page.url,
        "title": await page.title(),
        "snapshot": await snapshot(page),
    }


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def page_snapshot() -> str:
    """Return the current page as an accessibility tree (roles and names)."""
    return await snapshot(await get_page())


@mcp.tool(timeout=20.0)
async def click(
    role: Role,
    name: Annotated[str, "Accessible name exactly as shown in the snapshot"],
) -> str:
    """Click an element by its role and accessible name, then return the new snapshot."""
    page = await get_page()
    try:
        await page.get_by_role(role, name=name, exact=True).first.click(timeout=5000)
    except PlaywrightError:
        raise ToolError(
            f"No clickable {role} named '{name}'. Call page_snapshot to check."
        )
    await page.wait_for_load_state("domcontentloaded")
    return await snapshot(page)


@mcp.tool(timeout=20.0)
async def fill(
    label: Annotated[str, "The field's label, accessible textbox name, or placeholder"],
    value: str,
) -> str:
    """Fill a field by label, textbox name, or placeholder; wait up to 15s for editability."""
    page = await get_page()
    field = (
        page.get_by_label(label, exact=True)
        .or_(page.get_by_role("textbox", name=label, exact=True))
        .or_(page.get_by_placeholder(label, exact=True))
    )
    try:
        await field.first.fill(value, timeout=15000)
    except PlaywrightTimeoutError as e:
        raise ToolError(
            f"Could not fill field '{label}' by label, textbox name, or placeholder. "
            "It did not become editable within 15 seconds. "
            "Call page_snapshot to check the field name and whether it is editable."
        ) from e
    except PlaywrightError as e:
        raise ToolError(
            f"Could not fill field '{label}': the browser action failed. "
            "Call page_snapshot to inspect the current page before retrying."
        ) from e
    return f"Filled '{label}'."


@mcp.tool
async def press_key(
    key: Literal["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"],
) -> str:
    """Press a keyboard key on the focused element and return the new snapshot."""
    page = await get_page()
    await page.keyboard.press(key)
    return await snapshot(page)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def screenshot(full_page: bool = False) -> Image:
    """Capture a PNG of the page. Use only when visual layout matters."""
    page = await get_page()
    return Image(data=await page.screenshot(full_page=full_page), format="png")


@mcp.resource("browser://current-page", mime_type="application/json")
async def current_page() -> dict:
    """URL and title of the page the browser is on."""
    page = await get_page()
    return {"url": page.url, "title": await page.title()}


@mcp.prompt
def test_user_flow(url: str, goal: str) -> list[Message]:
    """Ask the model to run an exploratory test of one user flow."""
    return [
        Message(
            f"Open {url} and try to: {goal}. Use the snapshot to find elements. "
            "Report each step, anything that failed or looked wrong, and end with "
            "a Playwright test in Python that reproduces the flow."
        )
    ]


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8000)
