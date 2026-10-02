// A seam, because jsdom's `location.assign` cannot be spied on or replaced in tests.
export const navigateTo = (url: string) => window.location.assign(url);
