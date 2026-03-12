# Food Share (DSA Project)

This workspace contains a static HTML/CSS/JS frontend that uses Firebase for authentication and Firestore to store user and food item data. It also includes several C modules implementing common DSA structures and algorithms.

Web files:
- `index.html` - landing page with links
- `signup.html` - signup form (choose role: donor/receiver)
- `login.html` - login form
- `donor.html` - donor dashboard to add food items (all fields stored as strings)
- `receiver.html` - receiver dashboard to list food items
- `styles.css`, `app.js`, `firebase-config.js` (fill with your Firebase config)

WASM sorter:
- `c/wasm_sort.c` — a C quicksort implementation intended to be compiled to WebAssembly.
- After building it with Emscripten you will get `wasm_sort.js` and `wasm_sort.wasm`. Include the glue before `app.js` on pages that use sorting:

```html
<script src="/wasm_sort.js"></script>
<script type="module" src="/app.js"></script>
```

Build WASM (emsdk/emscripten required):

```bash
# from project root
emcc c/wasm_sort.c -O2 -s WASM=1 -s EXPORTED_FUNCTIONS='["_sort_ints","_malloc","_free"]' -s EXPORTED_RUNTIME_METHODS='["HEAP32"]' -o wasm_sort.js
```

The frontend will detect the Emscripten `Module` runtime and use the WASM sorter if available; otherwise it falls back to JS sort.

Firebase setup:
1. Create a Firebase project at https://console.firebase.google.com/
2. Enable Email/Password sign-in under Authentication
3. Create a Firestore database (start in test mode while developing)
4. Copy your Firebase config into `firebase-config.js`

Run the web app:
You can open the HTML files directly in a browser, or serve the folder with a simple static server. Example using Python 3:

```bash
# from inside the project folder
python3 -m http.server 5173
# then open http://localhost:5173/index.html
```

C modules:
- `c/stack.c`, `c/queue.c`, `c/linked_list.c`, `c/sorting.c` each contain test `main` functions.

Compile C examples:

```bash
gcc c/stack.c -o c/stack && ./c/stack
gcc c/queue.c -o c/queue && ./c/queue
gcc c/linked_list.c -o c/linked_list && ./c/linked_list
gcc c/sorting.c -o c/sorting && ./c/sorting
```
