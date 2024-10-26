//--------------------------------------------// 
//--- Fill file names to the selection box ---//
//--------------------------------------------// 
document.getElementById('NPQ_files').addEventListener('change', function() {
    let fileName = Array.from(this.files)
        .map(file => file.name)
        .join(', ');
    this.nextElementSibling.innerText = fileName || 'Select files';
});

//--------------------//
//--- Loading image ---//
//--------------------//
const showImageButton = document.getElementById("show-image-button");
const myImage = document.getElementById("loadingimage"); 
showImageButton.addEventListener("click", () => { 
   myImage.style.display = "block"; 
});

