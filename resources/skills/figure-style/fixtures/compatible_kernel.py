"""Independent compatible implementation used to exercise locator replacement."""

META_GREY = "#888888"


def apply_figure_style(*, frame="open", font=None, sizes=(8, 7, 6), grid=False):
    import matplotlib as mpl

    base, secondary, tick = sizes
    if frame not in {"open", "boxed", "none"}:
        raise ValueError("frame must be 'open', 'boxed', or 'none'")
    params = {
        "font.size": base,
        "axes.titlesize": base,
        "axes.labelsize": base,
        "legend.fontsize": secondary,
        "xtick.labelsize": tick,
        "ytick.labelsize": tick,
        "axes.titlelocation": "left",
        "axes.titleweight": "normal",
        "axes.grid": bool(grid),
        "grid.linewidth": 0.5,
        "grid.alpha": 0.25,
        "xtick.direction": "out",
        "ytick.direction": "out",
        "legend.frameon": False,
        "savefig.dpi": 300,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.1,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    }
    if font is not None:
        params["font.family"] = "sans-serif"
        params["font.sans-serif"] = [font]
    mpl.rcParams.update(params)
    mpl.rcParams["axes.spines.top"] = frame == "boxed"
    mpl.rcParams["axes.spines.right"] = frame == "boxed"
    mpl.rcParams["axes.spines.bottom"] = frame != "none"
    mpl.rcParams["axes.spines.left"] = frame != "none"


def set_frame(ax, style="open"):
    visibility = {
        "open": (True, True, False, False),
        "boxed": (True, True, True, True),
        "none": (False, False, False, False),
    }[style]
    for spine, visible in zip(("left", "bottom", "right", "top"), visibility):
        ax.spines[spine].set_visible(visible)
    ax.tick_params(left=style != "none", bottom=style != "none")


def panel_letter(ax, letter, dx=-0.18, dy=1.02, case="lower", fontsize=None):
    import matplotlib.pyplot as plt

    if fontsize is None:
        fontsize = plt.rcParams.get("font.size", 8) + 1
    label = letter.lower() if case == "lower" else letter.upper()
    ax.text(dx, dy, label, transform=ax.transAxes, fontweight="bold",
            fontsize=fontsize, va="bottom", ha="left")


def focal_palette(labels, focal, focal_color, other="muted", base_colors=None):
    import matplotlib.colors as colors
    import matplotlib.pyplot as plt

    focal_labels = {focal} if isinstance(focal, str) else set(focal)
    if not focal_labels.intersection(labels):
        raise ValueError(f"focal {focal!r} not found in labels")
    count = len(labels)
    if base_colors is None:
        base_colors = plt.rcParams["axes.prop_cycle"].by_key().get("color", ["#444444"])
    palette = [base_colors[index % len(base_colors)] for index in range(count)]
    if other == "grey":
        alternatives = ["#BCBCBC"] * count
    elif other == "ordinal":
        nonfocal_count = max(1, count - len(focal_labels))
        levels = ([0.55] if nonfocal_count == 1 else
                  [0.80 - 0.35 * index / (nonfocal_count - 1) for index in range(nonfocal_count)])
        ramp = [colors.to_hex((level, level, level)) for level in levels]
        alternatives, index = [], 0
        for label in labels:
            alternatives.append(ramp[min(index, nonfocal_count - 1)])
            index += label not in focal_labels
    else:
        alternatives = []
        for color in palette:
            red, green, blue = colors.to_rgb(color)
            mean = (red + green + blue) / 3
            alternatives.append(colors.to_hex(tuple(0.3 * value + 0.7 * mean
                                                     for value in (red, green, blue))))
    return [focal_color if label in focal_labels else alternatives[index]
            for index, label in enumerate(labels)]


def bar_with_points(ax, x, ymat, labels, colors, jitter=0.08, show_points=True,
                    errorbar=None, point_alpha=0.5, point_size=8):
    import numpy as np

    means = np.array([np.mean(values) for values in ymat], float)
    errors = None
    if errorbar and not show_points:
        if errorbar == "sd":
            errors = np.array([np.std(values, ddof=1) if np.asarray(values).size > 1 else 0
                               for values in ymat])
        elif errorbar == "ci95":
            from scipy.stats import t

            def half_width(values):
                size = np.asarray(values).size
                return (t.ppf(0.975, size - 1) * np.std(values, ddof=1) / np.sqrt(size)
                        if size > 1 else 0)
            errors = np.array([half_width(values) for values in ymat])
    ax.bar(x, means, color=colors, width=0.7, edgecolor="none", yerr=errors,
           error_kw={"elinewidth": 0.8, "capsize": 0})
    if show_points:
        for position, values in zip(x, ymat):
            values = np.asarray(values)
            if values.ndim and values.size > 1:
                offsets = (np.random.rand(values.size) - 0.5) * 2 * jitter
                ax.scatter(np.full(values.size, position) + offsets, values, s=point_size,
                           color="black", alpha=point_alpha, zorder=3, linewidths=0)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    return ax


def strip_with_median(ax, groups, values, colors=None, jitter=0.12):
    import numpy as np

    labels = list(groups)
    if colors is None:
        colors = ["#444444"] * len(labels)
    for index, (series, color) in enumerate(zip(values, colors)):
        series = np.asarray(series)
        offsets = (np.random.rand(series.size) - 0.5) * 2 * jitter
        ax.scatter(np.full(series.size, index) + offsets, series, s=10, color=color,
                   alpha=0.6, linewidths=0, zorder=2)
        median = np.median(series)
        ax.plot([index - 0.22, index + 0.22], [median, median], color="black", lw=1.6, zorder=3)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels)
    return ax


def goodness_arrow(ax, text="higher = better", loc="upper left", axis="y", fontsize=None):
    import matplotlib.pyplot as plt

    if fontsize is None:
        fontsize = plt.rcParams["legend.fontsize"]
    x, y = {"upper left": (0.02, 0.98), "upper right": (0.98, 0.98),
            "lower left": (0.02, 0.02), "lower right": (0.98, 0.02)}[loc]
    ax.text(x, y, ("↑ " if axis == "y" else "→ ") + text, transform=ax.transAxes,
            fontsize=fontsize, color=META_GREY, ha="left" if "left" in loc else "right",
            va="top" if "upper" in loc else "bottom")


def two_tier_label(name, meta):
    return f"{name}\n{meta}"


def end_of_line_labels(ax, xs, ys, labels, colors=None, dx=0.01, fontsize=None):
    import matplotlib.pyplot as plt

    if fontsize is None:
        fontsize = plt.rcParams["font.size"]
    if colors is None:
        colors = [None] * len(labels)
    span = ax.get_xlim()[1] - ax.get_xlim()[0]
    for x, y, label, color in zip(xs, ys, labels, colors):
        ax.text(x[-1] + dx * span, y[-1], label, color=color, va="center", ha="left",
                fontsize=fontsize)


def panel_crops(fig, dpi=None, pad_px=6, bbox_inches=None, pad_inches=None):
    import matplotlib as mpl
    import matplotlib.text

    if dpi is None:
        dpi = mpl.rcParams.get("savefig.dpi", fig.dpi)
        if dpi == "figure":
            dpi = fig.dpi
    dpi = float(dpi)
    if bbox_inches is None:
        bbox_inches = mpl.rcParams.get("savefig.bbox")
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    if bbox_inches == "tight":
        if pad_inches is None:
            pad_inches = mpl.rcParams.get("savefig.pad_inches", 0.1)
        saved_box = fig.get_tightbbox(renderer).padded(pad_inches)
        origin_x, origin_y = saved_box.x0, saved_box.y0
        width_inches, height_inches = saved_box.width, saved_box.height
    elif isinstance(bbox_inches, mpl.transforms.BboxBase):
        origin_x, origin_y = bbox_inches.x0, bbox_inches.y0
        width_inches, height_inches = bbox_inches.width, bbox_inches.height
    else:
        origin_x, origin_y = 0.0, 0.0
        width_inches, height_inches = fig.get_size_inches()
    width, height = int(round(width_inches * dpi)), int(round(height_inches * dpi))
    lettered = {}
    for axes in fig.axes:
        for text in axes.findobj(matplotlib.text.Text):
            label = (text.get_text() or "").strip()
            if len(label) == 1 and label.isalpha() and text.get_fontweight() in ("bold", 700):
                lettered[axes] = label
                break
    if not lettered:
        lettered = {axes: str(index) for index, axes in enumerate(fig.axes)}
    crops = {}
    for axes, label in lettered.items():
        bounds = axes.get_tightbbox(renderer)
        left = (bounds.x0 / fig.dpi - origin_x) * dpi
        right = (bounds.x1 / fig.dpi - origin_x) * dpi
        top = height - (bounds.y1 / fig.dpi - origin_y) * dpi
        bottom = height - (bounds.y0 / fig.dpi - origin_y) * dpi
        crops[label] = (max(int(left) - pad_px, 0), max(int(top) - pad_px, 0),
                        min(int(right) + pad_px, width), min(int(bottom) + pad_px, height))
    return crops
