const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
export function searchTerms(text) {
  return [
    ...new Set(
      [
        ...segmenter.segment(
          String(text)
            .toLowerCase()
            .replace(/[_:/-]+/g, " "),
        ),
      ]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment),
    ),
  ];
}

export function rankSearch(items, query, textOf, limit = 12) {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const terms = searchTerms(q);
  const docs = items.map((item) => ({
    item,
    text: textOf(item).toLowerCase(),
  }));
  const frequency = terms.map(
    (term) => docs.filter((d) => d.text.includes(term)).length,
  );
  return docs
    .map(({ item, text }, order) => ({
      item,
      order,
      score:
        (item.name?.toLowerCase() === q ? 100 : 0) +
        (text.includes(q) ? 20 : 0) +
        terms.reduce(
          (n, term, i) =>
            n +
            (text.includes(term)
              ? Math.log(1 + (items.length + 1) / (frequency[i] + 1)) *
                (item.name?.toLowerCase().includes(term) ? 3 : 1)
              : 0),
          0,
        ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((r) => r.item);
}
