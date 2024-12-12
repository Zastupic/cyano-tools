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

//-----------------------------//
//--- IMAGES ON FULL SCREEN ---//
//-----------------------------//
$('img[data-enlargeable]').addClass('img-enlargeable').click(function() {
    var src = $(this).attr('src');
    var modal;
  
    function removeModal() {
      modal.remove();
      $('body').off('keyup.modal-close');
    }
    modal = $('<div>').css({
      background: 'RGBA(0,0,0,.5) url(' + src + ') no-repeat center',
      backgroundSize: 'contain',
      width: '100%',
      height: '100%',
      position: 'fixed',
      zIndex: '10000',
      top: '0',
      left: '0',
      cursor: 'zoom-out'
    }).click(function() {
      removeModal();
    }).appendTo('body');
    //handling ESC
    $('body').on('keyup.modal-close', function(e) {
      if (e.key === 'Escape') {
        removeModal();
      }
    });
  });