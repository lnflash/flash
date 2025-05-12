/**
 * Stub Prometheus client for use when metrics are not enabled
 * In a real environment, this would be replaced with a proper prometheus client
 */

class Counter {
  constructor(options: any) {}
  inc(labels?: any) {}
}

class Histogram {
  constructor(options: any) {}
  observe(value: number, labels?: any) {}
}

export const promClient = {
  Counter,
  Histogram,
};