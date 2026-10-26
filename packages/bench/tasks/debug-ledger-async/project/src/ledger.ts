// The ledger: each entry changes one account's balance.

export interface Entry {
  account: string
  amount: number
}

export class Ledger {
  private balances = new Map<string, number>()

  balance(account: string): number {
    return this.balances.get(account) ?? 0
  }

  async apply(entry: Entry): Promise<void> {
    const current = await this.load(entry.account)
    this.balances.set(entry.account, current + entry.amount)
  }

  async applyAll(entries: Entry[]): Promise<void> {
    entries.forEach(async (entry) => {
      await this.apply(entry)
    })
  }

  // Balances are kept in memory here; the bank's ledger asks its accounts service, which answers a moment later.
  private async load(account: string): Promise<number> {
    const balance = this.balance(account)
    await new Promise((resolve) => setTimeout(resolve, 5))
    return balance
  }
}
