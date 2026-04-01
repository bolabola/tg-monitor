export function normalizeId(id) {
    return id.toString().replace(/^-100/, '');
}

/** 配置里带 `id`、可选 `note` 的项（源频道、转发目标等） */
export function labelNoteOrId(ref) {
    if (ref == null) return '';
    return ref.note || ref.id;
}
