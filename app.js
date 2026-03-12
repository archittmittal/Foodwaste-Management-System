import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js'
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js'
import { getFirestore, doc, setDoc, getDoc, collection, addDoc, deleteDoc, query, where, orderBy, getDocs, updateDoc } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js'
import { firebaseConfig } from './firebase-config.js'
import { isValidEmailFormat, isGmailAddress, isStrongPassword } from './validators.js'

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

// New: guards for handlers and concurrent loads
let handlersAttached = false
let loadFoodsInProgress = false

// Error message mapping for Firebase errors
function getErrorMessage(err) {
  if (!err) return 'An unknown error occurred'
  if (err.code === 'auth/email-already-in-use') return 'This email is already registered. Please log in or use a different email.'
  if (err.code === 'auth/weak-password') return 'Password is too weak. Please use a stronger password.'
  if (err.code === 'auth/invalid-email') return 'Invalid email address format.'
  if (err.code === 'auth/user-not-found') return 'No account found with this email.'
  if (err.code === 'auth/wrong-password') return 'Incorrect password. Please try again.'
  if (err.code === 'auth/too-many-requests') return 'Too many login attempts. Please try again later.'
  if (err.code === 'auth/network-request-failed') return 'Network error. Please check your connection and try again.'
  if (err.code === 'permission-denied') return 'You do not have permission to perform this action.'
  if (err.code === 'failed-precondition') return 'Unable to process request. Please try again.'
  if (err.message && err.message.includes('network')) return 'Network connection error. Please check your internet and try again.'
  return err.message || 'An error occurred. Please try again.'
}

// ==================== DATA STRUCTURES IMPLEMENTATION ====================
// 1. QUEUE: Claim Priority System (FIFO)
async function addClaimToQueue(foodId, claimerId, claimedQty) {
  try {
    const queueDoc = await getDoc(doc(db, 'claimQueues', foodId))
    let queue = queueDoc.exists() ? queueDoc.data().queue || [] : []
    queue.push({
      claimerId,
      claimedQty,
      timestamp: new Date().toISOString(),
      position: queue.length + 1
    })
    await setDoc(doc(db, 'claimQueues', foodId), { queue }, { merge: true })
    return queue.length // return position in queue
  } catch(e) {
    console.warn('Error adding to claim queue:', e)
    return null
  }
}

async function getClaimQueuePosition(foodId, claimerId) {
  try {
    const queueDoc = await getDoc(doc(db, 'claimQueues', foodId))
    if (!queueDoc.exists()) return null
    const queue = queueDoc.data().queue || []
    const position = queue.findIndex(c => c.claimerId === claimerId)
    return position >= 0 ? position + 1 : null
  } catch(e) {
    console.warn('Error getting queue position:', e)
    return null
  }
}

// 2. GRAPH: Donor-Receiver Network
async function recordExchange(donorId, receiverId, foodId, quantity) {
  try {
    // Create edge: donor → receiver
    const edgeDoc = `${donorId}_${receiverId}`
    const edgeRef = doc(db, 'userConnections', edgeDoc)
    const existingEdge = await getDoc(edgeRef)
    
    if (existingEdge.exists()) {
      await updateDoc(edgeRef, {
        exchangeCount: (existingEdge.data().exchangeCount || 0) + 1,
        totalQuantity: (existingEdge.data().totalQuantity || 0) + quantity,
        lastExchange: new Date().toISOString(),
        exchanges: [...(existingEdge.data().exchanges || []), { foodId, quantity, date: new Date().toISOString() }]
      })
    } else {
      await setDoc(edgeRef, {
        donorId,
        receiverId,
        exchangeCount: 1,
        totalQuantity: quantity,
        firstExchange: new Date().toISOString(),
        lastExchange: new Date().toISOString(),
        exchanges: [{ foodId, quantity, date: new Date().toISOString() }]
      })
    }
  } catch(e) {
    console.warn('Error recording exchange:', e)
  }
}

async function getUserConnections(userId) {
  try {
    // Find all exchanges where userId is donor or receiver
    const asDonerQuery = query(collection(db, 'userConnections'), where('donorId', '==', userId))
    const asReceiverQuery = query(collection(db, 'userConnections'), where('receiverId', '==', userId))
    
    const donorSnap = await getDocs(asDonerQuery)
    const receiverSnap = await getDocs(asReceiverQuery)
    
    const connections = []
    donorSnap.forEach(doc => connections.push({ type: 'donated', ...doc.data() }))
    receiverSnap.forEach(doc => connections.push({ type: 'received', ...doc.data() }))
    
    return connections
  } catch(e) {
    console.warn('Error fetching user connections:', e)
    return []
  }
}

// 3. TREE: Food Category Hierarchy
const FOOD_CATEGORIES = {
  'Veg': {
    'Vegetables': ['Tomato', 'Cucumber', 'Carrot', 'Onion', 'Potato'],
    'Fruits': ['Apple', 'Banana', 'Orange', 'Grapes', 'Mango'],
    'Grains': ['Rice', 'Wheat', 'Bread', 'Pasta', 'Cereal']
  },
  'Non-Veg': {
    'Meat': ['Chicken', 'Mutton', 'Beef', 'Pork'],
    'Fish': ['Fish', 'Prawns', 'Crab'],
    'Eggs': ['Chicken Eggs', 'Quail Eggs']
  },
  'Dairy': {
    'Milk Products': ['Milk', 'Yogurt', 'Cheese', 'Butter'],
    'Prepared': ['Ice Cream', 'Paneer']
  },
  'Prepared': {
    'Cooked': ['Rice', 'Curry', 'Bread', 'Snacks'],
    'Baked': ['Cake', 'Cookies', 'Bread', 'Pastries']
  }
}

function getCategoryForFood(foodName) {
  for (const [category, subcats] of Object.entries(FOOD_CATEGORIES)) {
    for (const [subcat, items] of Object.entries(subcats)) {
      if (items.some(item => foodName.toLowerCase().includes(item.toLowerCase()))) {
        return { category, subcategory: subcat }
      }
    }
  }
  return { category: 'Other', subcategory: 'Miscellaneous' }
}

function getAllCategories() {
  return Object.keys(FOOD_CATEGORIES)
}

function getSubcategories(category) {
  return Object.keys(FOOD_CATEGORIES[category] || {})
}

function getItemsInSubcategory(category, subcategory) {
  return FOOD_CATEGORIES[category]?.[subcategory] || []
}
// set up a global `Module`. We listen for Module.onRuntimeInitialized to know
// when it is safe to call exported functions like _sort_ints.
let wasmReady = false
if (window.Module) {
  if (typeof Module.onRuntimeInitialized === 'function') {
    Module.onRuntimeInitialized = () => {
      wasmReady = !!(Module._sort_ints && Module.HEAP32)
      const ws = document.getElementById('wasm-status')
      if (ws) ws.textContent = wasmReady ? 'WASM sorter ready' : 'WASM loaded but exports missing'
      console.log('WASM runtime initialized:', wasmReady)
    }
  } else {
    // Already initialized
    wasmReady = !!(Module._sort_ints && Module.HEAP32)
  }
}

async function handleSignup(e) {
  e.preventDefault()
  const emailEl = document.getElementById('email')
  const passwordEl = document.getElementById('password')
  const msg = document.getElementById('msg')
  
  if (!emailEl || !passwordEl || !msg) {
    console.error('Required form elements missing')
    return
  }
  
  const email = emailEl.value.trim()
  const password = passwordEl.value
  
  // basic client-side validation (also reflected live via inline UI)
  if(!isValidEmailFormat(email)){
    msg.textContent = 'Enter a valid email address (example@gmail.com)'
    return
  }
  // require gmail addresses so team can recover via Gmail when needed
  if(!isGmailAddress(email)){
    msg.textContent = 'Please sign up using a Gmail address (example@gmail.com)'
    return
  }
  if(!isStrongPassword(password)){
    msg.textContent = 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.'
    return
  }
  
  msg.textContent = 'Creating your account...'
  try{
    const userCred = await createUserWithEmailAndPassword(auth, email, password)
    const uid = userCred.user.uid
    // collect extra signup fields if present
    const fullName = document.getElementById('fullName')?.value || ''
    const address = document.getElementById('address')?.value || ''
    const city = document.getElementById('city')?.value || ''
    const pincode = document.getElementById('pincode')?.value || ''
    
    try {
      // create a users doc with profile info; role is chosen at dashboard time
      await setDoc(doc(db, 'users', uid), { email, fullName, address, city, pincode, createdAt: new Date().toISOString() })
    } catch(profileErr) {
      console.error('Profile creation error:', profileErr)
      msg.textContent = 'Account created but profile setup failed. Signing out...'
      await signOut(auth)
      setTimeout(() => {
        msg.textContent = 'Please try signing up again.'
      }, 1000)
      return
    }
    
    msg.textContent = 'Signup successful — redirecting...'
    // robust redirect: prefer replace, and add a timed fallback in case immediate navigation is blocked
    try{ location.replace('/dashboard.html') }catch(e){ location.href = '/dashboard.html' }
    setTimeout(()=>{ if(location.pathname.endsWith('/signup.html')) location.href = '/dashboard.html' }, 800)
  }catch(err){
    console.error('Signup error:', err)
    msg.textContent = getErrorMessage(err)
    msg.style.color = '#d32f2f'
  }
}

async function handleLogin(e){
  e.preventDefault()
  const emailEl = document.getElementById('email')
  const passwordEl = document.getElementById('password')
  const msg = document.getElementById('msg')
  
  if (!emailEl || !passwordEl || !msg) {
    console.error('Required form elements missing')
    return
  }
  
  const email = emailEl.value.trim()
  const password = passwordEl.value
  
  if(!isValidEmailFormat(email)){
    msg.textContent = 'Enter a valid email address.'
    return
  }
  
  if(!password){
    msg.textContent = 'Please enter your password.'
    return
  }
  
  msg.textContent = 'Signing in...'
  try{
    const userCred = await signInWithEmailAndPassword(auth, email, password)
    msg.textContent = 'Login successful — redirecting...'
    setTimeout(() => {
      location.href = '/dashboard.html'
    }, 500)
  }catch(err){
    console.error('Login error:', err)
    msg.textContent = getErrorMessage(err)
    msg.style.color = '#d32f2f'
  }
}

// Validation helpers
// Attach live validation UI handlers for forms
function attachValidationUI(){
  const signupForm = document.getElementById('signupForm')
  if(signupForm){
    const emailEl = signupForm.querySelector('#email')
    const pwdEl = signupForm.querySelector('#password')
    const emailHelp = document.getElementById('emailHelp')
    const pwdHelp = document.getElementById('pwdHelp')
    const signupBtn = document.getElementById('signupBtn')

    function update(){
      const email = emailEl ? emailEl.value : ''
      const pwd = pwdEl ? pwdEl.value : ''
      if(emailHelp) emailHelp.textContent = isValidEmailFormat(email) ? '' : 'Enter a valid email (example@gmail.com)'
      if(pwdHelp) pwdHelp.textContent = isStrongPassword(pwd) ? '' : 'Password must be 8+ chars with upper, lower, digit, special'
      if(signupBtn) signupBtn.disabled = !(isValidEmailFormat(email) && isGmailAddress(email) && isStrongPassword(pwd))
    }

    emailEl && emailEl.addEventListener('input', update)
    pwdEl && pwdEl.addEventListener('input', update)
    update()
  }

  const loginForm = document.getElementById('loginForm')
  if(loginForm){
    const emailEl = loginForm.querySelector('#email')
    const emailHelp = document.getElementById('loginEmailHelp')
    const loginBtn = document.getElementById('loginBtn')
    function updateLogin(){
      const email = emailEl ? emailEl.value : ''
      if(emailHelp) emailHelp.textContent = isValidEmailFormat(email) ? '' : 'Enter a valid email'
      if(loginBtn) loginBtn.disabled = !isValidEmailFormat(email)
    }
    emailEl && emailEl.addEventListener('input', updateLogin)
    updateLogin()
  }
}

// update header user info
function setHeaderUser(u){
  const header = document.querySelector('.header-inner')
  if(!header) return
  let info = header.querySelector('.user-info')
  if(!info){
    info = document.createElement('div')
    info.className = 'user-info'
    header.appendChild(info)
  }
  if(!u){
    // don't show header login on the signup or login pages (they already have an inline link)
    const path = location.pathname || ''
    if (path.endsWith('/signup.html') || path.endsWith('/login.html')) {
      info.innerHTML = ''
    } else {
      info.innerHTML = `<a class="email" href="/login.html">Login</a>`
    }
  } else {
    info.innerHTML = `<div class="email">${escapeHtml(u.email)}</div><button id="hdr-logout">Logout</button>`
    const btn = document.getElementById('hdr-logout')
    if(btn) btn.addEventListener('click', async ()=>{ await signOut(auth); location.href='/login.html' })
  }

  // Also toggle top-nav links for login/signup depending on auth state
  const nav = header.querySelector('.top-nav')
  if(nav){
    const loginLink = nav.querySelector('a[href="/login.html"]')
    const signupLink = nav.querySelector('a[href="/signup.html"]')
    if(u){
      if(loginLink) loginLink.style.display = 'none'
      if(signupLink) signupLink.style.display = 'none'
    } else {
      if(loginLink) loginLink.style.display = ''
      if(signupLink) signupLink.style.display = ''
    }
  }

  // If user is authenticated and is currently on the auth pages, redirect to dashboard
  try{
    const path = location.pathname || ''
    if(u && (path.endsWith('/signup.html') || path.endsWith('/login.html'))){
      // use replace so back doesn't keep auth page
      location.replace('/dashboard.html')
    }
  }catch(e){ /* ignore */ }

  // update auth debug on dashboard
  try{
    const authDebug = document.getElementById('authDebug')
    if(authDebug){
      authDebug.textContent = u ? `Signed in: ${u.email} (uid: ${u.uid})` : 'Not signed in'
    }
  }catch(e){ /* ignore */ }
}

// observe auth changes to update header
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js'
onAuthStateChanged(auth, (u)=> setHeaderUser(u))

// Helper: parse quantity string (e.g., "100 kg") into { value: 100, unit: "kg" }
function parseQuantity(str) {
  if (!str) return { value: 0, unit: '' }
  const match = str.trim().match(/^([\d.]+)\s*(.*)$/)
  if (!match) return { value: 0, unit: '' }
  return { value: parseFloat(match[1]) || 0, unit: match[2] || '' }
}

async function addFood(e){
  e.preventDefault()
  const nameEl = document.getElementById('name')
  const quantityEl = document.getElementById('quantity')
  const pickupLocationEl = document.getElementById('pickupLocation')
  const expiryHoursEl = document.getElementById('expiryHours')
  const msg = document.getElementById('msg')
  
  if (!nameEl || !quantityEl || !pickupLocationEl || !expiryHoursEl || !msg) {
    console.error('Required form elements missing')
    msg.textContent = 'Form validation failed: missing required fields'
    return
  }
  
  const name = nameEl.value.trim()
  const quantity = quantityEl.value.trim()
  const pickupLocation = pickupLocationEl.value.trim()
  const expiryHours = parseInt(expiryHoursEl.value, 10)
  const expiry = document.getElementById('expiry')?.value || ''
  
  const user = auth.currentUser
  if(!user){ 
    msg.textContent = 'Error: Not authenticated. Please log in again.'
    console.warn('addFood: no currentUser')
    return
  }

  // basic validation with clear messages
  if(!name || !quantity || !pickupLocation){ 
    msg.textContent = 'Please provide name, quantity, and pickup location.'
    return
  }
  
  if(!Number.isInteger(expiryHours) || expiryHours < 0 || expiryHours > 720){
    msg.textContent = 'Please enter a valid expiry time in hours (0-720).'
    return
  }

  // Parse quantity into value and unit
  const qParsed = parseQuantity(quantity)
  if (qParsed.value <= 0) {
    msg.textContent = 'Quantity must be a positive number (e.g., "100 kg").'
    return
  }

  console.log('addFood: user=', user.uid, { name, quantity, qParsed, expiry, expiryHours, pickupLocation })
  msg.textContent = 'Adding food...'
  msg.style.color = '#1976d2'
  
  try{
    // store fields; expiryHours must be integer per security rules
    // quantityValue/quantityUnit for the original amount
    // remainingQuantityValue/remainingQuantityUnit track what's left after partial claims
    const docRef = await addDoc(collection(db, 'foods'), {
      name: String(name),
      quantity: String(quantity),
      quantityValue: qParsed.value,
      quantityUnit: String(qParsed.unit),
      remainingQuantityValue: qParsed.value,
      remainingQuantityUnit: String(qParsed.unit),
      expiry: String(expiry),
      expiryHours: expiryHours,
      pickupLocation: String(pickupLocation),
      ownerId: user.uid,
      createdAt: new Date().toISOString()
    })
    console.log('addFood: added doc', docRef.id)
    msg.textContent = 'Food added successfully!'
    msg.style.color = '#2e7d32'
    const form = document.getElementById('foodForm')
    if(form) form.reset()
    // refresh donor list if visible
    const myList = document.getElementById('myList')
    if(myList) {
      try {
        await loadMyFoods()
      } catch(e) {
        console.warn('Error refreshing food list:', e)
      }
    }
  }catch(err){
    console.error('addFood error', err)
    msg.textContent = getErrorMessage(err)
    msg.style.color = '#d32f2f'
  }
}

async function loadMyFoods(){
  const myList = document.getElementById('myList')
  if(!myList) return
  myList.innerHTML = 'Loading your donations...'
  const user = auth.currentUser
  if(!user){ 
    myList.textContent = 'Error: Not authenticated. Please log in again.'
    return
  }
  try{
    const q = query(collection(db, 'foods'), where('ownerId', '==', user.uid))
    const snap = await getDocs(q)
    const items = []
    snap.forEach(s => items.push({ id: s.id, ...s.data() }))
    // sort by createdAt descending if present
    items.sort((a,b)=>{ const A = a.createdAt||''; const B = b.createdAt||''; return B.localeCompare(A) })
    if(items.length === 0){ myList.textContent = 'You have not added any donations yet.'; return }
    myList.innerHTML = ''
    for(const it of items){
      // Fetch all claims for this item (to show partial claims)
      let claims = []
      try{
        const qClaim = query(collection(db, 'claims'), where('foodId', '==', it.id))
        const snapClaim = await getDocs(qClaim)
        if(snapClaim.size > 0){
          for(const claimSnap of snapClaim.docs){
            const cd = claimSnap.data()
            let claimerName = cd.claimerEmail || 'Unknown'
            try{
              const claimerUser = await getDoc(doc(db, 'users', cd.claimerId))
              if(claimerUser.exists() && claimerUser.data()?.fullName){
                claimerName = claimerUser.data().fullName
              }
            }catch(e){
              console.warn('Error fetching claimer info:', e)
            }
            claims.push({ 
              name: claimerName, 
              email: cd.claimerEmail || 'N/A', 
              mobile: cd.claimerMobile || 'N/A',
              contactEmail: cd.claimerContactEmail || cd.claimerEmail || 'N/A',
              reason: cd.reason || 'No reason provided', 
              qty: cd.claimedQuantityValue || '?',
              unit: cd.claimedQuantityUnit || it.quantityUnit || '',
              deadline: cd.deadline24h || ''
            })
          }
        }
      }catch(e){ 
        console.warn('Error fetching claims:', e)
      }
      
      const div = document.createElement('div')
      div.className = 'item item-donor'
      // Show remaining quantity if tracked
      const remaining = (it.remainingQuantityValue !== undefined) ? it.remainingQuantityValue : it.quantityValue || it.quantity
      const remainingUnit = it.remainingQuantityUnit || it.quantityUnit || ''
      const isFullyClaimed = it.remainingQuantityValue !== undefined && it.remainingQuantityValue <= 0
      
      let removeBtn = `<button data-id="${escapeHtml(it.id)}" class="remove-btn">Remove</button>`
      let claimSection = ''
      if(claims.length > 0 || isFullyClaimed){
        removeBtn = ''
        let claimsHtml = ''
        for(const c of claims){
          claimsHtml += `<div style="margin-top:6px;font-size:11px;background:#f0f8f0;padding:8px;border-radius:4px;border-left:3px solid #2f9e44;">\n            <div><strong>📝 ${escapeHtml(c.name)}</strong> claimed <strong>${c.qty} ${escapeHtml(c.unit)}</strong></div>\n            <div style="margin-top:4px;">📱 <strong>${escapeHtml(c.mobile)}</strong> | 📧 <strong>${escapeHtml(c.contactEmail)}</strong></div>\n            <div style="margin-top:4px;color:#d3a600;"><strong>⏰ Collect by: ${c.deadline ? new Date(c.deadline).toLocaleString() : 'N/A'}</strong></div>\n            <div style="margin-top:4px;color:#666;">Reason: ${escapeHtml(c.reason)}</div>\n          </div>`
        }
        const claimedLabel = isFullyClaimed ? '✓ FULLY CLAIMED' : (claims.length > 0 ? `✓ PARTIAL CLAIMS (${claims.length})` : '✓ FULLY CLAIMED')
        claimSection = `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb"><div style="font-size:13px;color:#2f9e44;font-weight:600">${claimedLabel}</div>${claimsHtml}</div>`
      }
      
      div.innerHTML = `
        <div class="item-left">
          <strong>${escapeHtml(it.name)}</strong>
          <div class="item-details">Total: ${escapeHtml(it.quantity)} | Remaining: ${escapeHtml(String(remaining))} ${escapeHtml(remainingUnit)} | Hours: ${escapeHtml(String(it.expiryHours))}</div>
          ${claimSection}
        </div>
        <div class="item-right">
          ${removeBtn}
        </div>
      `
      myList.appendChild(div)
    }
    // attach remove handlers (optional simple delete)
    myList.querySelectorAll('.remove-btn').forEach(btn=>{
      btn.addEventListener('click', async (e)=>{
        const id = btn.getAttribute('data-id')
        if(!confirm('Are you sure you want to remove this item?')) return
        btn.disabled = true
        try{
          // simple delete flow; ensure only owner can delete via rules
          await deleteDoc(doc(db,'foods',id))
          await loadMyFoods()
        }catch(err){ 
          console.warn('Delete error:', err)
          btn.disabled = false
          alert('Delete failed: ' + getErrorMessage(err))
        }
      })
    })
  }catch(err){ 
    console.error('loadMyFoods error:', err)
    myList.textContent = 'Error loading donations: ' + getErrorMessage(err)
  }
}

async function loadFoods(){
  const list = document.getElementById('list')
  if (!list) return
  if (loadFoodsInProgress) {
    console.log('loadFoods: already running, skipping duplicate call')
    return
  }
  loadFoodsInProgress = true
  const wasmStatus = document.getElementById('wasm-status')
  if(wasmStatus) wasmStatus.textContent = wasmReady ? 'WASM sorter ready' : 'WASM sorter not ready'
  list.innerHTML = 'Loading available food items...'
  try{
      // fetch all foods
      const snap = await getDocs(collection(db, 'foods'))
      const items = []
      snap.forEach(docSnap => { const d = docSnap.data(); items.push({ id: docSnap.id, ...d }) })
      // dedupe by id to guard against accidental duplicates
      const unique = new Map()
      items.forEach(it => unique.set(it.id, it))
      const itemsToUse = Array.from(unique.values())
      const fetchInfo = document.getElementById('fetchInfo')
      if(fetchInfo) fetchInfo.textContent = `Fetched ${itemsToUse.length} items — ${new Date().toLocaleTimeString()}`
      console.log('loadFoods: items=', itemsToUse)
      if(itemsToUse.length === 0){ list.textContent = 'No food items available yet.'; return }
 
       // Sort items by expiryHours (ascending - soonest expiry first)
      itemsToUse.sort((a,b)=>{
        const A = (typeof a.expiryHours === 'number')?a.expiryHours:Number.MAX_SAFE_INTEGER
        const B = (typeof b.expiryHours === 'number')?b.expiryHours:Number.MAX_SAFE_INTEGER
        return A - B
      })
       if(wasmStatus) wasmStatus.textContent = wasmReady ? 'Using WASM sorter' : 'Using JS sorter'
 
       // Render items (show until remainingQuantityValue <= 0)
       list.innerHTML = ''
       let visibleCount = 0
      for(const it of itemsToUse){
         // Only hide items that are fully claimed (remaining quantity = 0 or less)
         const isFullyClaimed = (it.remainingQuantityValue !== undefined && it.remainingQuantityValue <= 0)
         if(isFullyClaimed) continue
         
         visibleCount++
         
         // Use pickupLocation from food document, fallback to profile city if not present
         let displayLocation = it.pickupLocation || 'Unknown'
         if(!it.pickupLocation && it.ownerId){
           try{
             const od = await getDoc(doc(db,'users',it.ownerId))
             if(od?.exists() && od.data()?.city){
               displayLocation = od.data().city
             }
           }catch(e){
             console.warn('Error fetching location:', e)
           }
         }
         
         // Show remaining quantity
         const remaining = (it.remainingQuantityValue !== undefined) ? it.remainingQuantityValue : (it.quantityValue || it.quantity)
         const remainingUnit = it.remainingQuantityUnit || it.quantityUnit || ''
         const totalQty = it.quantityValue || it.quantity
         
         // Get claims for this item to show what's been claimed
         let claimsInfo = []
         let totalClaimedQty = 0
         try {
           const qClaim = query(collection(db, 'claims'), where('foodId', '==', it.id))
           const snapClaim = await getDocs(qClaim)
           if(snapClaim.size > 0) {
             for(const claimSnap of snapClaim.docs) {
               const cd = claimSnap.data()
               let claimerName = cd.claimerEmail || 'Unknown'
               try {
                 const claimerUser = await getDoc(doc(db, 'users', cd.claimerId))
                 if(claimerUser.exists() && claimerUser.data()?.fullName) {
                   claimerName = claimerUser.data().fullName
                 }
               } catch(e) {
                 console.warn('Error fetching claimer:', e)
               }
               const claimedQty = cd.claimedQuantityValue || 0
               totalClaimedQty += claimedQty
               claimsInfo.push({
                 name: claimerName,
                 qty: claimedQty,
                 unit: cd.claimedQuantityUnit || remainingUnit,
                 mobile: cd.claimerMobile || 'N/A',
                 deadline: cd.deadline24h || ''
               })
             }
           }
         } catch(e) {
           console.warn('Error fetching claims for receiver view:', e)
         }
         
         // Build claims display for receiver
         let claimsDisplay = ''
         if(claimsInfo.length > 0) {
           let claimsHtml = claimsInfo.map(c => 
             `<div style="font-size:11px;margin-top:4px;padding:4px;background:#fff3cd;border-radius:3px;">
               <strong>⚠️ ${escapeHtml(c.name)}</strong> claimed <strong>${c.qty} ${escapeHtml(c.unit)}</strong>
             </div>`
           ).join('')
           claimsDisplay = `<div style="margin-top:6px;border-top:1px solid #e0e0e0;padding-top:6px;border-left:3px solid #ff9800;">
             <div style="font-size:12px;color:#ff6f00;font-weight:600;">📋 ${claimsInfo.length} Claim(s)</div>
             ${claimsHtml}
           </div>`
         }
         
         // Status badge showing remaining percentage
         const remainingPercent = totalQty > 0 ? Math.round((remaining / totalQty) * 100) : 0
         let statusBadge = ''
         if(remainingPercent <= 25) {
           statusBadge = '<span style="background:#d32f2f;color:white;padding:4px 8px;border-radius:3px;font-size:11px;font-weight:600;">🔴 Running Out!</span>'
         } else if(remainingPercent <= 50) {
           statusBadge = '<span style="background:#ff9800;color:white;padding:4px 8px;border-radius:3px;font-size:11px;font-weight:600;">🟠 Half Left</span>'
         }
         
         const div = document.createElement('div')
         div.className = 'item item-receiver'
         div.innerHTML = `
           <div class="item-left">
             <strong>${escapeHtml(it.name)}</strong>
             <div class="item-details" style="margin-top:4px;">
               <div>📦 Total: ${escapeHtml(totalQty)} ${escapeHtml(remainingUnit)} | 📉 Remaining: <strong style="color:#2e7d32;font-size:14px;">${escapeHtml(String(remaining))} ${escapeHtml(remainingUnit)}</strong> (${remainingPercent}%)</div>
               <div style="margin-top:3px;font-size:12px;color:#666;">⏱️ Expiry: ${escapeHtml(it.expiry)} | ${escapeHtml(String(it.expiryHours))}h</div>
             </div>
             ${claimsDisplay}
           </div>
           <div class="item-right">
             <div style="margin-bottom:8px;">
               ${statusBadge}
             </div>
             <div class="city-badge">📍 ${escapeHtml(displayLocation)}</div>
             <button class="claim-btn" data-id="${escapeHtml(it.id)}" data-owner="${escapeHtml(it.ownerId||'')}" style="margin-top:8px;">Claim Now</button>
           </div>
         `
         list.appendChild(div)
       }
       
       if(visibleCount === 0) {
         list.innerHTML = '<p style="text-align:center;color:#999;">All available items have been claimed.</p>'
         return
       }
       
       // Attach claim handlers
       list.querySelectorAll('.claim-btn').forEach(b=> b.addEventListener('click', async (ev)=>{
         const target = ev.currentTarget
         const foodId = target.getAttribute('data-id')
         const ownerId = target.getAttribute('data-owner')
         target.disabled = true
         try {
           await claimFood(foodId, ownerId)
         } catch(e) {
           console.error('Claim error:', e)
           target.disabled = false
         }
       }))
  }catch(err){
    console.error('loadFoods error:', err)
    const list = document.getElementById('list')
    if (list) {
      list.textContent = 'Failed to load items: ' + getErrorMessage(err)
    }
  } finally {
    loadFoodsInProgress = false
   }
}

// Claim a food item: prompt for a short reason and agreement, then create a claims doc
async function claimFood(foodId, ownerId){
  if(!foodId) {
    alert('Error: Invalid food item.')
    return
  }
  const user = auth.currentUser
  if(!user){ 
    alert('You must be signed in to claim an item.')
    return
  }
  
  // Get the food item to check its quantity and unit
  let foodItem = null
  try {
    const foodDoc = await getDoc(doc(db, 'foods', foodId))
    if (foodDoc.exists()) foodItem = foodDoc.data()
  } catch(e) { 
    console.warn('Could not fetch food item:', e)
    alert('Error: Could not fetch food item details. Please try again.')
    return
  }
  
  if (!foodItem) {
    alert('Error: Food item not found. It may have been removed.')
    return
  }
  
  // Prompt for claimed quantity (e.g., "20 kg")
  const claimedQtyStr = prompt('Enter quantity you want to claim (e.g., "20 kg"):')
  if(claimedQtyStr === null) return // cancelled
  const claimedQty = parseQuantity(claimedQtyStr)
  if (claimedQty.value <= 0) {
    alert('Please enter a valid positive quantity (e.g., "20 kg").')
    return
  }
  
  // Validate quantities and units
  const remainingQty = foodItem.remainingQuantityValue || foodItem.quantityValue || 0
  const remainingUnit = foodItem.remainingQuantityUnit || foodItem.quantityUnit || ''
  const totalQty = foodItem.quantityValue || 0
  const totalUnit = foodItem.quantityUnit || ''
  
  // Check unit match
  if (claimedQty.unit !== remainingUnit) {
    alert(`Unit mismatch! Item unit is "${remainingUnit}" but you entered "${claimedQty.unit}".`)
    return
  }
  
  // Check if claimed quantity exceeds remaining
  if (claimedQty.value > remainingQty) {
    alert(`Cannot claim ${claimedQty.value} ${claimedQty.unit}.\nAvailable: ${remainingQty} ${remainingUnit} out of ${totalQty} ${totalUnit}.\nPlease enter a smaller amount.`)
    return
  }
  
  // Prompt for reason
  const reason = prompt('Enter a short reason why you need this item (e.g., family need):')
  if(reason === null) return // cancelled
  if(reason.trim().length < 5){ 
    alert('Please provide a more complete reason (at least 5 characters).')
    return
  }
  
  // Prompt for mobile number
  const mobile = prompt('Enter your mobile number (so donor can contact you):')
  if(mobile === null) return // cancelled
  if(mobile.trim().length < 5){ 
    alert('Please provide a valid mobile number.')
    return
  }
  
  // Prompt for email
  const email = prompt('Confirm your email (for verification):', user.email || '')
  if(email === null) return // cancelled
  if(!email.trim()){ 
    alert('Please provide a valid email.')
    return
  }
  
  // Get pickup location to show in confirmation
  const pickupLocation = foodItem.pickupLocation || 'Unknown location'
  
  // First confirmation: 24-hour pickup deadline
  const agreePickup = confirm('IMPORTANT TERMS:\n\n📍 PICKUP LOCATION:\n' + pickupLocation + '\n\n⏰ DEADLINE: You must collect this food within 24 hours.\n\n❌ NO CANCELLATION: Once claimed, this cannot be cancelled.\n\nYou must personally collect the food. Do you agree?')
  if(!agreePickup){ 
    alert('You must agree to the terms to claim the item.')
    return
  }
  
  // Second confirmation: Personal responsibility
  const agreeResponsibility = confirm('FINAL CONFIRMATION:\n\n✓ I will personally collect the food from the given location\n✓ I understand this claim CANNOT be cancelled\n✓ I will not share or misuse this food\n\nClick OK to confirm claim, or Cancel to withdraw.')
  if(!agreeResponsibility){ 
    alert('Claim cancelled.')
    return
  }
  
  try{
    const cdoc = await addDoc(collection(db, 'claims'), {
      foodId,
      ownerId: ownerId || null,
      claimerId: user.uid,
      claimerEmail: user.email || '',
      claimerMobile: String(mobile).slice(0, 20),
      claimerContactEmail: String(email).slice(0, 100),
      reason: String(reason).slice(0, 500),
      claimedQuantityValue: claimedQty.value,
      claimedQuantityUnit: String(claimedQty.unit),
      pickupLocation: String(pickupLocation),
      agreed: true,
      cannotBeCancelled: true,
      createdAt: new Date().toISOString(),
      deadline24h: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    })
    
    // Queue integration: Add claim to queue (FIFO tracking)
    let queuePosition = null
    try {
      queuePosition = await addClaimToQueue(foodId, user.uid, claimedQty.value)
    } catch(qErr) {
      console.warn('Error adding to claim queue:', qErr)
    }
    
    // Graph integration: Record exchange between donor and receiver
    if (ownerId && user.uid !== ownerId) {
      try {
        await recordExchange(ownerId, user.uid, foodId, claimedQty.value)
      } catch(gErr) {
        console.warn('Error recording exchange:', gErr)
      }
    }
    
    const positionText = queuePosition ? `\n- Queue Position: #${queuePosition}` : ''
    alert('✓ Claim recorded!\n- Donor will contact you at ' + mobile + ' to arrange pickup.\n- You have 24 hours to collect.' + positionText + '\n- Claim ID: ' + cdoc.id)
    
    // Update food item: decrement remaining quantity if units match
    if (foodItem && claimedQty.unit === (foodItem.quantityUnit || '')) {
      try {
        const newRemaining = Math.max(0, (foodItem.remainingQuantityValue || foodItem.quantityValue || 0) - claimedQty.value)
        await updateDoc(doc(db, 'foods', foodId), {
          remainingQuantityValue: newRemaining
        })
      } catch(updateErr) {
        console.warn('Error updating remaining quantity:', updateErr)
      }
    }
    
    // refresh lists
    try{ await loadFoods() }catch(e){ console.warn('Error refreshing foods list:', e) }
    try{ await loadMyFoods() }catch(e){ console.warn('Error refreshing my foods list:', e) }
  }catch(err){
    console.error('claimFood error:', err)
    alert('Failed to record claim: ' + getErrorMessage(err))
  }
}

function escapeHtml(s){
  if(!s) return ''
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
}

function attachHandlers(){
  if (handlersAttached) return
  handlersAttached = true
   const signupForm = document.getElementById('signupForm')
   if(signupForm) signupForm.addEventListener('submit', handleSignup)
   const loginForm = document.getElementById('loginForm')
   if(loginForm) loginForm.addEventListener('submit', handleLogin)
   const foodForm = document.getElementById('foodForm')
   if(foodForm) foodForm.addEventListener('submit', addFood)
   const refresh = document.getElementById('refreshList')
   if(refresh) refresh.addEventListener('click', (e)=>{ e.preventDefault(); loadFoods() })
   const logout = document.getElementById('logout')
   if(logout) logout.addEventListener('click', async ()=>{ await signOut(auth); location.href='/login.html' })
}

// on page load decide actions
document.addEventListener('DOMContentLoaded', async ()=>{
  attachHandlers()
  // set up live validation UI on signup/login pages
  try{ attachValidationUI() }catch(e){ console.warn('Validation UI attach failed:', e) }
  // unified dashboard handling
  if(location.pathname.endsWith('/dashboard.html')){
    const user = auth.currentUser
    if(!user){
      // wait for auth, else redirect to login
      let resolved = false
      const timeout = setTimeout(()=>{ 
        if(!resolved) {
          console.warn('Auth check timeout, redirecting to login')
          location.href='/login.html'
        }
      }, 4000)
      
      auth.onAuthStateChanged(async (u)=>{
        clearTimeout(timeout)
        resolved = true
        if(!u){ 
          location.href = '/login.html'
        } else { 
          try {
            await setupDashboard()
          } catch(e) {
            console.error('Dashboard setup error:', e)
            alert('Error loading dashboard: ' + getErrorMessage(e))
          }
        }
      })
    } else {
      try {
        await setupDashboard()
      } catch(e) {
        console.error('Dashboard setup error:', e)
        alert('Error loading dashboard: ' + getErrorMessage(e))
      }
    }
  }
});

// Load claims for donor - show items that have been claimed by others

async function setupDashboard(){
  const roleSelect = document.getElementById('roleSelect')
  const donorView = document.getElementById('donorView')
  const receiverView = document.getElementById('receiverView')
  const msg = document.getElementById('msg')
  const list = document.getElementById('list')
  
  if (!roleSelect || !donorView || !receiverView) {
    throw new Error('Required dashboard elements missing')
  }

  function showRole(r){
    try {
      if(r==='donor'){ 
        donorView.style.display='block'
        receiverView.style.display='none'
        loadMyFoods().catch(e => {
          console.error('Error loading donor foods:', e)
          if(msg) msg.textContent = 'Error loading donations: ' + getErrorMessage(e)
        })
      }
      else{ 
        donorView.style.display='none'
        receiverView.style.display='block'
        loadFoods().catch(e => {
          console.error('Error loading receiver foods:', e)
          if(list) list.textContent = 'Error loading items: ' + getErrorMessage(e)
        })
      }
    } catch(e) {
      console.error('Error switching roles:', e)
      alert('Error switching views: ' + getErrorMessage(e))
    }
  }

  roleSelect.addEventListener('change', (e)=> showRole(e.target.value))
  showRole(roleSelect.value)
  attachHandlers()
}