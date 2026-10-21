// Registers the player the site tests play as, through the real login page, and keeps the session.
import { test as setup, expect } from '@playwright/test';
import { PLAYER_STATE } from '../../playwright.config.mjs';

setup('a new player registers on the login page and lands on the table', async ({ page }) => {
  await page.goto('/play/');
  await expect(page).toHaveURL(/\/play\/login\.html\?next=%2Fplay%2F$/);
  await page.locator('#tab-register').click();
  await page.locator('input[name="username"]').fill('tester');
  await page.locator('input[name="password"]').fill('tester-pass-1');
  await page.locator('input[name="again"]').fill('tester-pass-1');
  await page.locator('#auth-submit').click();
  await expect(page).toHaveURL(/\/play\/$/);
  await expect(page.locator('#start-nav .user-btn')).toContainText('tester');
  await page.context().storageState({ path: PLAYER_STATE });
});
