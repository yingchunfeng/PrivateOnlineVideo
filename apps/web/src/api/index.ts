import { ApiClient } from "./client";
export const mockEnabled = import.meta.env.DEV && import.meta.env.VITE_API_MODE === "mock";
const transport = mockEnabled ? (await import("./mock")).createMockTransport() : window.fetch.bind(window);
export const api = new ApiClient(transport);
