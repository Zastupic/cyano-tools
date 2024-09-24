# Cyano-tools

## Computational tools for the analysis of fluorescence, microscopic and spectroscopic data, as obtained in laboratories working with algae, cyanobacteria and plants

### The tools, available online (https://tools-py.e-cyanobacterium.org/), are designed to perform the following analyses:
- ***Fluorometry***
  - ***OJIP curves***
    - Shifting (to F<sub>0</sub>' and F<sub>P</sub>) and normalizing (between F<sub>0</sub>' and F<sub>P</sub>) the measured OJIP curves, uploaded by a user
    - Identifying F<sub>J</sub>, F<sub>I</sub> and F<sub>P</sub> timing based on a second derivation of the fluorescence signal
    - Eventual manual correction of F<sub>J</sub> and F<sub>I</sub> timing
    - Calculating relevant parameters, including those based on F<sub>J</sub> and F<sub>I</sub>
    - Plotting all OJIP curves (measured, shifted and normalized), second derivations and the calculated parameters
    - Exporting all results and plots to a summary **.xlsx** file, available for download
  - ***Rapid light curves***
    - Plotting the measured rapid light curves (all fluorescence traces), uploaded by a user
    - Fitting the measured curves by the equation of Platt et al., 1980
    - Calculating relevant parameters
    - Exporting all results and plots to a summary **.xlsx** file, available for download
- ***Microscopy***
  - ***Cell counting*** _(fluorescence microscopy, confocal microscopy)_
    - ***Round cells***
      - Automated identification of the cells on a fluorescence microscopy image uploaded by a user
      - Automated counting of the identified cells
      - Eventual manual correction
    - ***Filamentous strains***
      - Automated identification of filaments on a fluorescence microscopy image uploaded by a user
      - Automated splitting the filaments to individual cells, and counting the individual cells
      - Eventual manual correction
  - ***Cell size estimation*** _(confocal microscopy)_
    - ***Round cells***
      - Manual selection of the cells on a confocal microscopy image uploaded by a user
      - Automated determination of size of the selected cells
      - Plotting the cell size histogram
      - Exporting all results and plots to a summary **.xlsx** file, available for download
    - ***Filamentous strains***
      - Manual selection of the cells on a confocal microscopy image uploaded by a user
      - Manual determination of size of the selected cells
      - Plotting the cell size histogram
      - Exporting all results and plots to a summary **.xlsx** file, available for download
  - ***Pixel profiles***
    - ***Round cells***
      - Manual selection of the cells on a confocal microscopy image uploaded by a user
      - Automated determination of pixels intensity across the cell profile (with fixed angle of 15°)
      - Plotting average pixel intensities across cellular profiles for all selected cells
      - Exporting all results and plots to a summary **.xlsx** file, available for download
    - ***Filamentous strains***
      - Manual selection of the cells and cells cross-section on a confocal microscopy image uploaded by a user
      - Automated determination of pixels intensity across the selected cells cross-secions
      - Plotting average pixel intensities across cellular profiles for all selected cells
      - Exporting all results and plots to a summary **.xlsx** file, available for download
- ***Spectrofluorometry***
  - Selection of type of organism
    -  Strain with _chlorophyll_ only
    -  Strain with _chlorophyll_ and _phycocyanin_
    -  Strain with _chlorophyll_ and _phycoerythrin_
    -  Strain with _chlorophyll_ and _phycocyanin_ and _phycoerythrin_
  - Selection of excitation and emission wavelengths of interest within the measured fluorescence excitation-emission matrix, uploaded by a user
  - Selection of excitation and emission wavelengths for normalization
  - Calculation of parameters related to ratio of PSII/PSI and antenna attachment to PSII or PSI
  - Plotting the spectra and calculated parameters
  - Exporting all results and plots to a summary **.xlsx** file, available for download

### The tools accept data files from the following devices:
- ***Fluorometers***
  - **Multi-Color PAM / Dual PAM**, Walz
    - .csv
  - **AquaPen / FluorPen**, Photon System Instruments
    - .txt
- ***Confocal and fluorescence microscopes***
  - .png, .jpg, .jpeg, .tif, .tiff, .bmp, .gif
- ***Spectrofluorometers***
  - **FP series**, Jasco
    - .csv

### The tools are based on python ***Flask*** framework, and are hosted at https://www.pythonanywhere.com/. The files related to individual tools are located in the folder ***Website*** within main folder (***Flask_server***). The folder ***Website*** contains the following sub-folders and files:
- Folder **static**
  - Sub-folders **images**, **files** and **uploads**
  - Files:
    - The main **.css** file
    - All **.js** files
- Folder **templates**
  - All **.html** files
- Files:
  - All **.py** files

