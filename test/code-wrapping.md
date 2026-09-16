# Code wrapping controls

In the **terminal viewer**, press `w` to wrap or unwrap all code blocks. Press `r` to refresh while keeping that choice, and `Esc` to close. Reopening starts unwrapped.

In the **browser**, use **Wrap all code** (or **Wrap** in the watch toolbar), then hover over the diagram and choose **Unwrap**. `Tab` also reveals the controls; on touch devices they stay visible. The global button shows **mixed**; clicking it wraps everything again.

## Long code line

```ts
const message = "Please check that the latest simulation results are consistent with the observations, retain the original measurement units, and report any differences between the training dataset and the independent validation dataset.";
console.log(message);
```

## Fixed-width diagram

```text
+-------------------+     +-------------------+
|    Input data     | --> |       Model       |
+-------------------+     +-------------------+
```

## Aligned output

```text
DATASET            SAMPLES    ERROR    STATUS
training              1200     0.03    PASS
validation             300     0.05    PASS
```

## Long diff lines

```diff
- const report = "Use the original calibration results, preserve the original measurement units, and display the summary for the training dataset alongside the independent validation dataset.";
+ const report = "Use the updated calibration results, preserve the original measurement units, and display the summary for the training dataset alongside the independent validation dataset.";
```

**Copy** preserves indentation and logical line breaks, regardless of wrapping. It briefly shows **Copied** or **Failed**; try pasting into an editor.
