import { describe, it, expect, beforeEach } from 'vitest';
import { isAIPanelOpen, focusAIPanelInput } from '../features/ai-copilot.js';

describe('AI panel focus helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app">
        <div id="ai-panel">
          <div id="ai-panel-content">
            <textarea class="ai-chat-textarea"></textarea>
          </div>
        </div>
      </div>`;
  });

  it('isAIPanelOpen reflects the ai-panel-open class on #app', () => {
    const app = document.getElementById('app');
    expect(isAIPanelOpen()).toBe(false);
    app.classList.add('ai-panel-open');
    expect(isAIPanelOpen()).toBe(true);
  });

  it('focusAIPanelInput focuses the chat textarea', () => {
    const textarea = document.querySelector('.ai-chat-textarea');
    focusAIPanelInput();
    expect(document.activeElement).toBe(textarea);
  });

  it('focusAIPanelInput is a no-op when the input is absent', () => {
    document.body.innerHTML = '<div id="app"></div>';
    expect(() => focusAIPanelInput()).not.toThrow();
  });
});
