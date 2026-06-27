// Live-run fixture, mirroring the PHP OrderService: all-public methods, no
// constructor deps, no imports — so the SliceRunner can instrument, load in a vm,
// and drive it end to end. Each public method is a valid waypoint anchor.

export class OrderService {
  private taxRate = 0.1;

  process(items: Array<{ price: number }>): { subtotal: number; tax: number; total: number } {
    const subtotal = this.subtotal(items);
    const tax = this.tax(subtotal);
    return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
  }

  subtotal(items: Array<{ price: number }>): number {
    return items.reduce((sum, i) => sum + i.price, 0);
  }

  tax(subtotal: number): number {
    return Math.round(subtotal * this.taxRate * 100) / 100;
  }
}
