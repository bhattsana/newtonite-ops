"""Optional Playwright smoke test for a running local frontend/API demo."""

import os
import re

from playwright.sync_api import expect, sync_playwright


FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")
DEMO_EMAIL = os.environ.get("DEMO_EMAIL", "member@demo.test")
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "demo-local-only")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(FRONTEND_URL, wait_until="networkidle", timeout=30000)
        page.get_by_label("Email").fill(DEMO_EMAIL)
        page.get_by_label("Password").fill(DEMO_PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", name="Operational overview")).to_be_visible(
            timeout=15000
        )
        assert page.evaluate("Object.keys(sessionStorage).length") == 0
        assert page.evaluate("Object.keys(localStorage).length") == 0
        print("PASS browser login, dashboard, and no browser-stored session token")

        title = "Browser smoke item " + os.urandom(4).hex()
        page.get_by_role("link", name=re.compile("Create work item")).click()
        page.get_by_label("Title").fill(title)
        page.get_by_label("Description").fill("Created through the browser smoke test.")
        page.get_by_role("button", name="Create", exact=True).click()
        expect(page).to_have_url(re.compile(r"/items/\d+$"), timeout=15000)
        expect(page.get_by_role("heading", name=title)).to_be_visible()
        expect(page.get_by_text("created this item")).to_be_visible()
        print("PASS browser work-item creation and persisted activity")

        page.get_by_role("button", name="Sign out").click()
        expect(page.get_by_role("button", name="Sign in")).to_be_visible(timeout=10000)
        page.goto(f"{FRONTEND_URL}/items/1", wait_until="networkidle")
        expect(page.get_by_role("button", name="Sign in")).to_be_visible(timeout=10000)
        print("PASS logout and protected-route behavior")
        browser.close()


if __name__ == "__main__":
    main()
