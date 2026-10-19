import '@testing-library/jest-dom/vitest';
// jsdom has no <dialog> modal support; emulate just enough for the Confirm component.
HTMLDialogElement.prototype.showModal ||= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close ||= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
if (!globalThis.crypto?.randomUUID) Object.defineProperty(globalThis, 'crypto', { value: { ...globalThis.crypto, randomUUID: () => `${Date.now()}-${Math.random()}` } });
afterEach(() => sessionStorage.clear());
