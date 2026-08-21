function terms(text) {
  const normalized = String(text ?? "").toLowerCase();
  const latin = normalized.match(/[a-z0-9]+/g) ?? [];
  const han = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  const grams = han.flatMap((word) => {
    if (word.length < 2) return [word];
    return Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2));
  });
  return [...latin, ...grams];
}

export class Bm25Index {
  constructor(documents, { k1 = 1.2, b = 0.75 } = {}) {
    this.documents = documents.map((document) => {
      const tokens = terms(document.text);
      const frequency = new Map();
      for (const token of tokens) {
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
      return { ...document, tokens, frequency };
    });
    this.k1 = k1;
    this.b = b;
    this.averageLength =
      this.documents.reduce((sum, item) => sum + item.tokens.length, 0) /
        Math.max(this.documents.length, 1);
    this.documentFrequency = new Map();
    for (const document of this.documents) {
      for (const token of new Set(document.tokens)) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      }
    }
  }

  search(query, { limit = 5, filter = () => true } = {}) {
    const queryTerms = [...new Set(terms(query))];
    return this.documents
      .filter(filter)
      .map((document) => {
        const score = queryTerms.reduce((total, token) => {
          const count = document.frequency.get(token) ?? 0;
          if (!count) return total;
          const df = this.documentFrequency.get(token) ?? 0;
          const idf = Math.log(1 + (this.documents.length - df + 0.5) / (df + 0.5));
          const denominator =
            count +
            this.k1 *
              (1 - this.b + this.b * (document.tokens.length / Math.max(this.averageLength, 1)));
          return total + idf * ((count * (this.k1 + 1)) / denominator);
        }, 0);
        return { ...document, score };
      })
      .filter((document) => document.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ tokens: _tokens, frequency: _frequency, ...document }) => document);
  }
}
