//--------------------------------------------// 
//--- Fill file names to the selection box ---//
//--------------------------------------------// 
  document.getElementById('light_curve_files').addEventListener('change', function() {
    let fileName = Array.from(this.files)
        .map(file => file.name)
        .join(', ');
    this.nextElementSibling.innerText = fileName || 'Select files';
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

//--------------------------------------------------------------------//
//--- ACCEPT ONLY NUMBERS, COMMA AND DOT AS INPUT FOR FORM-CONTROL ---//
//--------------------------------------------------------------------//
function isNumberKey(evt) {
    var charCode = (evt.which) ? evt.which : evt.keyCode
    if ((charCode < 48 || charCode > 57) && charCode != 44 && charCode != 46)
      return false;
    return true;
  }
  
//------------------------------------//
//--- RELOAD PAGE ON LAST POSITION ---//
//------------------------------------//
function refreshPageAtPosition () {
    sessionStorage.setItem("scroll", window.scrollY);
  }
  window.onload = function () {
    sessionStorage.setItem("scroll", window.scrollY);
    }
  
//--------------------//
//--- Loading image ---//
//--------------------//
const showImageButton = document.getElementById("show-image-button");
const myImage = document.getElementById("loadingimage"); 
showImageButton.addEventListener("click", () => { 
   myImage.style.display = "block"; 
});