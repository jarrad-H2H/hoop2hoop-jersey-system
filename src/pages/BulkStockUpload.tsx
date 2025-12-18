const moveSizeRow = (rowId: string, direction: "up" | "down") => {
  setSizeRows((prev) => {
    const idx = prev.findIndex((r) => r.id === rowId);
    if (idx === -1) return prev;

    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= prev.length) return prev;

    const next = [...prev];
    const tmp = next[idx];
    next[idx] = next[targetIdx];
    next[targetIdx] = tmp;

    // keep sort_order aligned in UI immediately (1..N)
    return next.map((r, i) => ({ ...r, sort_order: i + 1 }));
  });

  setSuccessMessage("");
  setError(null);
};

const saveSizeOrder = async () => {
  if (!selectedClubId) return;

  setSubmitting(true);
  setError(null);
  setSuccessMessage("");

  try {
    // Persist sort_order for each club_size row
    const updates = sizeRows.map((r, index) => ({
      id: r.id,
      sort_order: index + 1,
    }));

    const { error } = await supabase.from("club_sizes").upsert(updates, {
      onConflict: "id",
    });

    if (error) {
      console.error("saveSizeOrder error", error);
      setError("Failed to save size order.");
      return;
    }

    setSuccessMessage("Size order saved.");
  } finally {
    setSubmitting(false);
  }
};
