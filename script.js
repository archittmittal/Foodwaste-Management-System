// Handles only UI toggle between Login and Signup
const loginBtn = document.getElementById("loginBtn");
const signupBtn = document.getElementById("signupBtn");
const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");
const goSignup = document.getElementById("goSignup");
const goLogin = document.getElementById("goLogin");

loginBtn.addEventListener("click", () => {
  loginForm.classList.add("active");
  signupForm.classList.remove("active");
  loginBtn.classList.add("active");
  signupBtn.classList.remove("active");
});

signupBtn.addEventListener("click", () => {
  signupForm.classList.add("active");
  loginForm.classList.remove("active");
  signupBtn.classList.add("active");
  loginBtn.classList.remove("active");
});

goSignup.addEventListener("click", () => signupBtn.click());
goLogin.addEventListener("click", () => loginBtn.click());
